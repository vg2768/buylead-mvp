import { json, normalizePhone, PHONE_RE, hit, startWaVerify, waStatus } from '../lib/common.mjs';

export const config = { path: ['/api/verify/start', '/api/verify/status'] };

// OTP_MODE=whatsapp: the visitor sends a code to our WhatsApp number (free). Any other mode: tell the page to use the code-by-SMS flow.
export default async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (process.env.OTP_MODE !== 'whatsapp') return json({ mode: 'otp' });

  const secret = process.env.OTP_SECRET;
  const bizNumber = (process.env.WHATSAPP_BUSINESS_NUMBER || '').replace(/\D/g, '');
  if (!secret || secret.length < 16 || !bizNumber) {
    console.error('WhatsApp verification needs OTP_SECRET (16+ chars) and WHATSAPP_BUSINESS_NUMBER');
    return json({ error: 'Service is not configured yet.' }, 500);
  }

  const body = await req.json().catch(() => ({}));
  const phone = normalizePhone(body.phone);
  if (!PHONE_RE.test(phone)) return json({ error: 'Enter a valid 10-digit Indian mobile number.' }, 400);
  const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown';
  const path = new URL(req.url).pathname;

  if (path.endsWith('/status')) {
    if (!(await hit('wa-status-ip', ip, 400, 10 * 60 * 1000))) return json({ error: 'Too many requests.' }, 429);
    return json({ status: await waStatus(secret, String(body.token || '').slice(0, 120), phone) });
  }

  if (!(await hit('wa-start-ip', ip, 10, 10 * 60 * 1000)) || !(await hit('wa-start-phone', phone, 6, 60 * 60 * 1000))) {
    return json({ error: 'Too many requests. Please try again later.' }, 429);
  }
  const { code, token } = await startWaVerify(secret, phone);
  const text = `Verify my number for VGS Enterprises. Code: ${code}`;
  return json({ mode: 'whatsapp', token, wa_link: `https://wa.me/${bizNumber}?text=${encodeURIComponent(text)}` });
};
