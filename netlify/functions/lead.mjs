import {
  json, clean, normalizePhone, PHONE_RE, CITIES, MACHINES,
  store, hit, verifyOtp, notifyNewLead, newLeadKey,
} from '../lib/common.mjs';

export const config = { path: '/api/leads' };

export default async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const secret = process.env.OTP_SECRET;
  if (!secret || secret.length < 16) return json({ error: 'Service is not configured yet.' }, 500);

  const b = await req.json().catch(() => ({}));
  if (b.website) return json({ ok: true }); // honeypot: bots fill this, humans never see it

  const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown';
  if (!(await hit('lead-ip', ip, 10, 10 * 60 * 1000))) {
    return json({ error: 'Too many requests. Please try again in a few minutes.' }, 429);
  }

  const phone = normalizePhone(b.phone);
  const name = clean(b.name, 80);
  const company = clean(b.company, 120);
  const city = clean(b.city, 30);
  const machine = clean(b.machine, 40);
  const quantity = Number.parseInt(b.quantity, 10);
  const duration = b.duration_months === '' || b.duration_months == null ? null : Number.parseInt(b.duration_months, 10);
  const notes = clean(b.notes, 500);
  const source = clean(b.source, 60);

  if (name.length < 2) return json({ error: 'Please enter your name.' }, 400);
  if (!PHONE_RE.test(phone)) return json({ error: 'Enter a valid 10-digit Indian mobile number.' }, 400);
  if (!CITIES.includes(city)) return json({ error: 'Please choose a city.' }, 400);
  if (!MACHINES.includes(machine)) return json({ error: 'Please choose a machine type.' }, 400);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) return json({ error: 'Quantity must be between 1 and 500.' }, 400);
  if (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 120)) {
    return json({ error: 'Duration must be between 1 and 120 months.' }, 400);
  }

  const otp = await verifyOtp(secret, clean(b.otp_token, 120), phone, clean(b.otp, 6));
  if (!otp.ok) return json({ error: otp.error }, 400);

  // one lead per phone per 24 hours: acknowledge repeats without creating or alerting again
  const recent = store('recent-phones');
  const last = await recent.get(phone, { type: 'json' });
  if (last && Date.now() - last.at < 24 * 60 * 60 * 1000) return json({ ok: true, duplicate: true });

  const lead = {
    created_at: new Date().toISOString(),
    name, phone, company: company || null, city, machine, quantity,
    duration_months: duration, notes: notes || null, source: source || null,
    status: 'new', internal_note: null,
  };
  await store('leads').setJSON(newLeadKey(), lead);
  await recent.setJSON(phone, { at: Date.now() });

  await notifyNewLead(lead); // never throws; failures are logged and the lead is already saved
  return json({ ok: true });
};
