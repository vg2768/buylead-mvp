import { json, normalizePhone, PHONE_RE, hit, newOtp, deliverOtp } from '../lib/common.mjs';

export const config = { path: '/api/otp/send' };

export default async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const secret = process.env.OTP_SECRET;
  if (!secret || secret.length < 16) {
    console.error('OTP_SECRET is missing or too short (use 16+ random characters)');
    return json({ error: 'Service is not configured yet.' }, 500);
  }

  const body = await req.json().catch(() => ({}));
  const phone = normalizePhone(body.phone);
  if (!PHONE_RE.test(phone)) return json({ error: 'Enter a valid 10-digit Indian mobile number.' }, 400);

  const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown';
  if (!(await hit('otp-gap', phone, 1, 30_000))) {
    return json({ error: 'Please wait 30 seconds before requesting another code.' }, 429);
  }
  const okIp = await hit('otp-ip', ip, 8, 10 * 60 * 1000);
  const okPhone = await hit('otp-phone', phone, 5, 60 * 60 * 1000);
  if (!okIp || !okPhone) return json({ error: 'Too many requests. Please try again later.' }, 429);

  const { code, token } = newOtp(secret, phone);
  try {
    await deliverOtp(phone, code);
  } catch (e) {
    console.error('OTP delivery failed:', e.message);
    return json({ error: 'Could not send the code. Please try again.' }, 502);
  }
  return json({ ok: true, token });
};
