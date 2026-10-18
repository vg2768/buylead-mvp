import { createHmac } from 'node:crypto';
import { safeEqual, recordWaMessage, sendWhatsAppText } from '../lib/common.mjs';

export const config = { path: '/api/whatsapp/webhook' };

// Meta calls this URL. GET = one-time setup handshake. POST = incoming WhatsApp events (signed with the app secret).
export default async (req) => {
  if (req.method === 'GET') {
    const u = new URL(req.url);
    const expected = process.env.WHATSAPP_VERIFY_TOKEN;
    if (expected && u.searchParams.get('hub.mode') === 'subscribe' && safeEqual(u.searchParams.get('hub.verify_token') || '', expected)) {
      return new Response(u.searchParams.get('hub.challenge') || '', { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) { console.error('WHATSAPP_APP_SECRET is not set; webhook refuses all events'); return new Response('Not configured', { status: 500 }); }
  const raw = await req.text();
  const expected = 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex');
  if (!safeEqual(req.headers.get('x-hub-signature-256') || '', expected)) return new Response('Bad signature', { status: 401 });

  let payload;
  try { payload = JSON.parse(raw); } catch { return new Response('ok', { status: 200 }); }
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      for (const m of change.value?.messages || []) {
        if (m.type !== 'text') continue;
        try {
          if (await recordWaMessage(m.from, m.text?.body)) {
            // free-form reply inside the 24h window the customer just opened: no charge
            await sendWhatsAppText(m.from, 'Thanks, your number is verified. Go back to the page to finish your request.').catch((e) => console.error(e.message));
          }
        } catch (e) { console.error('webhook message failed:', e.message); }
      }
    }
  }
  return new Response('ok', { status: 200 });
};
