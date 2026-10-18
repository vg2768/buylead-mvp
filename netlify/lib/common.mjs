import { createHmac, randomBytes, randomInt, timingSafeEqual, createHash } from 'node:crypto';
import { getStore } from '@netlify/blobs';

export const CITIES = ['Chennai', 'Bangalore', 'Hyderabad', 'Other'];
export const MACHINES = ['Filter coffee', 'Bean to cup', 'Not sure'];
export const STATUSES = ['new', 'called', 'quoted', 'won', 'lost'];
export const PHONE_RE = /^[6-9]\d{9}$/;

export const OTP_TTL_MS = 10 * 60 * 1000;

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export const clean = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

// Normalise to a bare 10-digit number: drop spaces/dashes, then a +91 / 91 prefix (only when 12 digits) or a leading 0 (only when 11 digits)
export function normalizePhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

// ---------- storage: Netlify Blobs in production, in-memory only for local tests (USE_MEMORY_STORE=1) ----------
const mem = new Map(); // storeName -> Map(key -> json string)
function memoryStore(name) {
  if (!mem.has(name)) mem.set(name, new Map());
  const m = mem.get(name);
  return {
    async get(key) { const v = m.get(key); return v === undefined ? null : JSON.parse(v); },
    async setJSON(key, value) { m.set(key, JSON.stringify(value)); },
    async delete(key) { m.delete(key); },
    async list() { return { blobs: [...m.keys()].sort().map((key) => ({ key })) }; },
  };
}
export function store(name) {
  if (process.env.USE_MEMORY_STORE === '1') return memoryStore(name);
  return getStore({ name, consistency: 'strong' });
}
const getJSON = (s, key) => s.get(key, { type: 'json' });

// ---------- rate limiting (counters in the store, fixed window) ----------
export async function hit(bucket, id, limit, windowMs) {
  const s = store('ratelimit');
  const key = `${bucket}-${encodeURIComponent(id)}`;
  const now = Date.now();
  let e = await getJSON(s, key);
  if (!e || e.reset < now) e = { count: 0, reset: now + windowMs };
  e.count += 1;
  await s.setJSON(key, e);
  return e.count <= limit;
}
export async function peek(bucket, id) {
  const e = await getJSON(store('ratelimit'), `${bucket}-${encodeURIComponent(id)}`);
  return e && e.reset >= Date.now() ? e.count : 0;
}

// ---------- stateless OTP ----------
// The server never stores the code. It hands the browser a signed token (id.exp.sig) and later
// recomputes HMAC(secret, id.exp.phone.code) to check what the visitor typed.
const otpSign = (secret, id, exp, phone, code) =>
  createHmac('sha256', secret).update(`${id}.${exp}.${phone}.${code}`).digest('hex');

export function newOtp(secret, phone) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const id = randomBytes(8).toString('hex');
  const exp = Date.now() + OTP_TTL_MS;
  return { code, token: `${id}.${exp}.${otpSign(secret, id, exp, phone, code)}` };
}

// returns { ok:true, id } or { ok:false, error }
export async function verifyOtp(secret, token, phone, code) {
  const [id, expStr, sig] = String(token || '').split('.');
  const exp = Number(expStr);
  if (!/^[0-9a-f]{16}$/.test(id || '') || !Number.isFinite(exp) || !/^[0-9a-f]{64}$/.test(sig || '')) {
    return { ok: false, error: 'Please request a new code.' };
  }
  if (exp < Date.now()) return { ok: false, error: 'Code expired. Please request a new one.' };
  const used = store('otp-used');
  if (await used.get(id)) return { ok: false, error: 'Code already used. Please request a new one.' };
  if (!(await hit('otp-attempt', id, 5, 15 * 60 * 1000))) {
    return { ok: false, error: 'Too many wrong attempts. Please request a new code.' };
  }
  if (!/^\d{6}$/.test(code) || !safeEqual(otpSign(secret, id, exp, phone, code), sig)) {
    return { ok: false, error: 'Incorrect code.' };
  }
  await used.setJSON(id, { at: Date.now() });
  return { ok: true, id };
}

// MSG91 "Send OTP" API. We send our own code (the `otp` parameter) because the signed token must match it.
async function sendMsg91Otp(phone, code) {
  const { MSG91_AUTH_KEY: authkey, MSG91_OTP_TEMPLATE_ID: templateId } = process.env;
  if (!authkey || !templateId) throw new Error('MSG91 is not configured (set MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID)');
  const url = new URL('https://control.msg91.com/api/v5/otp');
  url.searchParams.set('template_id', templateId);
  url.searchParams.set('mobile', `91${phone}`);
  url.searchParams.set('otp', code);
  url.searchParams.set('authkey', authkey);
  const r = await fetch(url, { headers: { authkey } });
  // MSG91 can answer HTTP 200 with {"type":"error"}, so judge by the body, not only the status.
  // The error text below never includes the URL, so the auth key and code stay out of the logs.
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.type !== 'success') {
    throw new Error(`MSG91 ${r.status}: ${String(data.message || 'unexpected response').slice(0, 200)}`);
  }
}

export async function deliverOtp(phone, code) {
  if (process.env.OTP_MODE === 'msg91') return sendMsg91Otp(phone, code);
  const url = process.env.OTP_WEBHOOK_URL;
  if (process.env.OTP_MODE === 'webhook' && url) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: `+91${phone}`, code, message: `Your verification code is ${code}. Valid for 10 minutes.` }),
    });
    if (!r.ok) throw new Error(`OTP webhook returned ${r.status}`);
    return;
  }
  console.log(`[DEV OTP] +91${phone} -> ${code}`); // visible in the Netlify function log; testing only
}

// ---------- alerts ----------
const waParam = (s) => ({ type: 'text', text: String(s || '-').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 200) || '-' });

export function leadText(lead) {
  return (
    `New lead\n` +
    `${lead.name}${lead.company ? ` (${lead.company})` : ''}\n` +
    `Phone: +91${lead.phone}\n` +
    `City: ${lead.city}\n` +
    `Wants: ${lead.quantity} x ${lead.machine}` +
    (lead.duration_months ? ` for ${lead.duration_months} months` : '') +
    (lead.notes ? `\nNotes: ${lead.notes}` : '') +
    `\nWhatsApp: https://wa.me/91${lead.phone}`
  );
}

export async function sendWhatsAppAlert(lead) {
  const env = process.env;
  const to = (env.WHATSAPP_TO || '').replace(/\D/g, '');
  const body = env.WHATSAPP_TEMPLATE
    ? {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: env.WHATSAPP_TEMPLATE,
          language: { code: env.WHATSAPP_TEMPLATE_LANG || 'en' },
          // template body must have exactly these 4 variables: {{1}} name, {{2}} phone, {{3}} city, {{4}} requirement
          components: [{
            type: 'body',
            parameters: [
              waParam(lead.name + (lead.company ? ` (${lead.company})` : '')),
              waParam(`+91${lead.phone}`),
              waParam(lead.city),
              waParam(`${lead.quantity} x ${lead.machine}` + (lead.duration_months ? ` for ${lead.duration_months} months` : '') + (lead.notes ? `. Notes: ${lead.notes}` : '')),
            ],
          }],
        },
      }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body: leadText(lead), preview_url: false } };

  const r = await fetch(`https://graph.facebook.com/${env.WHATSAPP_API_VERSION || 'v23.0'}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.WHATSAPP_TOKEN}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const e = (await r.json().catch(() => ({}))).error || {};
    throw new Error(`WhatsApp ${r.status} code=${e.code ?? '?'} ${e.message ?? ''}`.trim());
  }
}

// Awaited before the function returns, because serverless functions can freeze right after responding.
export async function notifyNewLead(lead) {
  const env = process.env;
  const jobs = [];
  if (env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_TO) jobs.push(sendWhatsAppAlert(lead));
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: leadText(lead), disable_web_page_preview: true }),
      }).then((r) => { if (!r.ok) throw new Error(`Telegram ${r.status}`); })
    );
  }
  if (jobs.length === 0) console.log(`[LEAD ALERT]\n${leadText(lead)}`);
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === 'rejected') console.error('Alert failed:', r.reason?.message);
  return results.filter((r) => r.status === 'fulfilled').length;
}

// newest-first key: Blobs lists keys in ascending order, so invert the timestamp
export const newLeadKey = () => `${String(9_999_999_999_999 - Date.now()).padStart(13, '0')}-${randomBytes(3).toString('hex')}`;
