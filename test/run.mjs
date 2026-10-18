// Runs the three functions directly (no Netlify needed) against an in-memory store,
// with Meta's Graph API stubbed so nothing is really sent. Run: npm test
import assert from 'node:assert/strict';

process.env.WHATSAPP_TOKEN = 'EAAtesttoken123456';
process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
process.env.WHATSAPP_TO = '+91 98765 43210';
process.env.WHATSAPP_TEMPLATE = 'new_lead_alert';

const waCalls = [];
const realFetch = globalThis.fetch;
let waShouldFail = false;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('graph.facebook.com')) {
    waCalls.push({ url: String(url), headers: opts.headers, body: JSON.parse(opts.body) });
    return waShouldFail
      ? new Response(JSON.stringify({ error: { code: 131047, message: 'Re-engagement message' } }), { status: 400 })
      : new Response(JSON.stringify({ messages: [{ id: 'wamid.test' }] }), { status: 200 });
  }
  return realFetch(url, opts);
};

let lastOtp = '';
const realLog = console.log;
console.log = (...a) => { const m = /\[DEV OTP\] \+91(\d+) -> (\d+)/.exec(String(a[0])); if (m) lastOtp = m[2]; else realLog(...a); };
const realErr = console.error;
const errors = [];
console.error = (...a) => errors.push(a.join(' '));

const { default: otpSend } = await import('../netlify/functions/otp-send.mjs');
const { default: lead } = await import('../netlify/functions/lead.mjs');
const { default: admin } = await import('../netlify/functions/admin.mjs');
const { hit } = await import('../netlify/lib/common.mjs');

let ipCounter = 0;
const ctx = (ip = `10.0.0.${++ipCounter}`, params = {}) => ({ ip, params }); // unique IP per call unless a test pins one
const post = (url, body) => new Request('http://x' + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const call = async (fn, req, c = ctx()) => { const r = await fn(req, c); return { status: r.status, body: await r.json() }; };

const baseLead = (phone, over = {}) => ({ name: 'Priya', phone, company: 'Acme\nTech', city: 'Bangalore', machine: 'Bean to cup', quantity: 3, duration_months: 6, notes: 'line1\nline2', ...over });
async function getOtp(phone, ip) {
  const r = await call(otpSend, post('/api/otp/send', { phone }), ctx(ip));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { token: r.body.token, code: lastOtp };
}

let n = 0;
const ok = (name) => realLog(`  ok ${++n}. ${name}`);

// --- OTP send validation
assert.equal((await call(otpSend, post('/api/otp/send', { phone: '12345' }))).status, 400); ok('rejects invalid phone');
assert.equal((await call(otpSend, new Request('http://x/api/otp/send'))).status, 405); ok('rejects GET');

// --- happy path, including a number starting with 91
let { token, code } = await getOtp('9123456780', '2.2.2.2');
assert.match(token, /^[0-9a-f]{16}\.\d+\.[0-9a-f]{64}$/); assert.match(code, /^\d{6}$/);
assert.equal((await call(otpSend, post('/api/otp/send', { phone: '9123456780' }), ctx('2.2.2.2'))).status, 429); ok('30s resend gap enforced');
let r = await call(lead, post('/api/leads', { ...baseLead('9123456780'), otp: code, otp_token: token }));
assert.deepEqual(r, { status: 200, body: { ok: true } }); ok('lead saved with valid OTP (number starting with 91)');

// --- WhatsApp payload
assert.equal(waCalls.length, 1);
const wa = waCalls[0];
assert.equal(wa.url, 'https://graph.facebook.com/v23.0/1234567890/messages');
assert.equal(wa.headers.authorization, 'Bearer EAAtesttoken123456');
assert.equal(wa.body.to, '919876543210'); assert.equal(wa.body.type, 'template');
assert.equal(wa.body.template.name, 'new_lead_alert');
const params = wa.body.template.components[0].parameters.map((p) => p.text);
assert.deepEqual(params, ['Priya (Acme Tech)', '+919123456780', 'Bangalore', '3 x Bean to cup for 6 months. Notes: line1 line2']);
assert.ok(params.every((t) => !/[\n\t]/.test(t))); ok('WhatsApp template call is correctly formed and newline-free');

// --- token replay, duplicates, wrong code, tampering
r = await call(lead, post('/api/leads', { ...baseLead('9123456780'), otp: code, otp_token: token }));
assert.equal(r.status, 400); assert.match(r.body.error, /already used/); ok('OTP token cannot be reused');

// (the 30s phone gap blocks an immediate second send for the same phone, so use fresh phones below)
({ token, code } = await getOtp('9000000001', '4.4.4.4'));
const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
r = await call(lead, post('/api/leads', { ...baseLead('9000000001'), otp: wrong, otp_token: token }));
assert.equal(r.status, 400); assert.equal(r.body.error, 'Incorrect code.'); ok('wrong code rejected');
r = await call(lead, post('/api/leads', { ...baseLead('9000000002'), otp: code, otp_token: token }));
assert.equal(r.status, 400); ok('token bound to the phone it was issued for');
const [id, exp, sig] = token.split('.');
r = await call(lead, post('/api/leads', { ...baseLead('9000000001'), otp: code, otp_token: `${id}.${Number(exp) + 999999}.${sig}` }));
assert.equal(r.status, 400); ok('tampered expiry rejected');
r = await call(lead, post('/api/leads', { ...baseLead('9000000001'), otp: code, otp_token: `${id}.${Date.now() - 1}.${sig}` }));
assert.equal(r.status, 400); ok('expired token rejected');
r = await call(lead, post('/api/leads', { ...baseLead('9000000001'), otp: code, otp_token: token }));
assert.equal(r.status, 200); ok('correct code still works after failed tries');

// --- attempt limit: 5 wrong guesses burn the token
({ token, code } = await getOtp('9000000003', '5.5.5.5'));
const bad = String((Number(code) + 7) % 1000000).padStart(6, '0');
for (let i = 0; i < 5; i++) await call(lead, post('/api/leads', { ...baseLead('9000000003'), otp: bad, otp_token: token }));
r = await call(lead, post('/api/leads', { ...baseLead('9000000003'), otp: code, otp_token: token }));
assert.equal(r.status, 400); assert.match(r.body.error, /Too many/); ok('5 wrong attempts lock the token, even for the right code');

// --- 24h duplicate: acknowledged, but no second alert
({ token, code } = await getOtp('9000000004', '6.6.6.6'));
await call(lead, post('/api/leads', { ...baseLead('9000000004'), otp: code, otp_token: token }));
const before = waCalls.length;
const second = await (async () => {
  // fresh token for same phone: bypass 30s gap by issuing the token directly
  const { newOtp } = await import('../netlify/lib/common.mjs');
  const t = newOtp(process.env.OTP_SECRET, '9000000004');
  return call(lead, post('/api/leads', { ...baseLead('9000000004'), otp: t.code, otp_token: t.token }));
})();
assert.deepEqual(second.body, { ok: true, duplicate: true }); assert.equal(waCalls.length, before); ok('same phone within 24h: no duplicate lead or alert');

// --- validation
({ token, code } = await getOtp('9000000005', '7.7.7.7'));
for (const [label, over] of [['name', { name: 'A' }], ['city', { city: 'Mumbai' }], ['machine', { machine: 'Fridge' }], ['quantity', { quantity: 0 }], ['duration', { duration_months: 999 }]]) {
  assert.equal((await call(lead, post('/api/leads', { ...baseLead('9000000005', over), otp: code, otp_token: token }))).status, 400, label);
}
ok('field validation (name, city, machine, quantity, duration)');
assert.deepEqual((await call(lead, post('/api/leads', { website: 'spam', name: 'Bot' }))).body, { ok: true }); ok('honeypot silently accepted, nothing saved');

// --- alert failure must not lose the lead
waShouldFail = true;
({ token, code } = await getOtp('9000000006', '8.8.8.8'));
r = await call(lead, post('/api/leads', { ...baseLead('9000000006'), otp: code, otp_token: token }));
assert.equal(r.status, 200); assert.ok(errors.some((e) => e.includes('WhatsApp 400 code=131047'))); waShouldFail = false;
ok('WhatsApp failure is logged and the lead is still saved');

// --- IP rate limit on lead endpoint
let limited = false;
for (let i = 0; i < 12; i++) if ((await call(lead, post('/api/leads', { name: 'x' }), ctx('9.9.9.9'))).status === 429) limited = true;
assert.ok(limited); ok('per-IP rate limit on lead endpoint');

// --- admin
const get = (url, pw, c) => call(admin, new Request('http://x' + url, { headers: pw ? { 'x-admin-password': pw } : {} }), c);
assert.equal((await get('/api/admin/leads', null)).status, 401); ok('admin: no password rejected');
assert.equal((await get('/api/admin/leads', 'wrong')).status, 401); ok('admin: wrong password rejected');
let list = await get('/api/admin/leads', 'test-admin');
assert.equal(list.status, 200); assert.ok(list.body.leads.length >= 4);
assert.equal(list.body.leads[0].status, 'new'); ok('admin: lists leads');
const first = list.body.leads.at(-1);
assert.ok(new Date(list.body.leads[0].created_at) >= new Date(first.created_at)); ok('admin: newest first');
const patch = (key, body) => call(admin, new Request('http://x/api/admin/leads/' + key, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-admin-password': 'test-admin' }, body: JSON.stringify(body) }), ctx('1.1.1.1', { key }));
assert.equal((await patch(first.key, { status: 'called', internal_note: 'spoke, wants quote' })).status, 200);
assert.equal((await patch(first.key, { status: 'bogus' })).status, 400);
assert.equal((await patch('nope', { status: 'won' })).status, 404);
list = await get('/api/admin/leads?status=called', 'test-admin');
assert.equal(list.body.leads.length, 1); assert.equal(list.body.leads[0].internal_note, 'spoke, wants quote'); ok('admin: update status/note, filter, bad inputs handled');
list = await get('/api/admin/leads?city=Chennai', 'test-admin');
assert.equal(list.body.leads.length, 0); ok('admin: city filter');

for (let i = 0; i < 10; i++) await get('/api/admin/leads', 'guess' + i, ctx('5.4.3.2'));
assert.equal((await get('/api/admin/leads', 'test-admin', ctx('5.4.3.2'))).status, 429); ok('admin: IP locked out after 10 failures, even with the right password');
assert.equal((await get('/api/admin/leads', 'test-admin', ctx('6.7.8.9'))).status, 200); ok('admin: other IPs unaffected');

delete process.env.OTP_SECRET;
assert.equal((await call(otpSend, post('/api/otp/send', { phone: '9000000009' }))).status, 500); ok('refuses to run without OTP_SECRET');

realLog(`\nAll ${n} checks passed.`);
