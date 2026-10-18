import { json, clean, safeEqual, store, hit, peek, CITIES, STATUSES } from '../lib/common.mjs';

export const config = { path: ['/api/admin/leads', '/api/admin/leads/:key'] };

const MAX_FAILURES = 10;
const FAIL_WINDOW = 15 * 60 * 1000;

async function authorize(req, context) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return json({ error: 'Inbox is disabled: set ADMIN_PASSWORD.' }, 503);
  const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown';
  // lock out an IP after repeated failures, even if a later guess would be right
  if ((await peek('admin-fail', ip)) >= MAX_FAILURES) return json({ error: 'Too many attempts. Try again later.' }, 429);
  if (!safeEqual(req.headers.get('x-admin-password') || '', password)) {
    await hit('admin-fail', ip, MAX_FAILURES, FAIL_WINDOW);
    return json({ error: 'Wrong password.' }, 401);
  }
  return null;
}

export default async (req, context) => {
  const denied = await authorize(req, context);
  if (denied) return denied;

  const leads = store('leads');
  const key = context?.params?.key;

  if (req.method === 'GET' && !key) {
    const url = new URL(req.url);
    const status = clean(url.searchParams.get('status'), 20);
    const city = clean(url.searchParams.get('city'), 30);
    const { blobs } = await leads.list();
    const rows = [];
    for (const { key: k } of blobs.slice(0, 300)) { // keys sort newest first
      const lead = await leads.get(k, { type: 'json' });
      if (!lead) continue;
      if (STATUSES.includes(status) && lead.status !== status) continue;
      if (CITIES.includes(city) && lead.city !== city) continue;
      rows.push({ key: k, ...lead });
    }
    return json({ leads: rows, statuses: STATUSES });
  }

  if (req.method === 'PATCH' && key) {
    const body = await req.json().catch(() => ({}));
    const lead = await leads.get(key, { type: 'json' });
    if (!lead) return json({ error: 'Not found' }, 404);
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) return json({ error: 'Bad status' }, 400);
      lead.status = body.status;
    }
    if (body.internal_note !== undefined) lead.internal_note = clean(body.internal_note, 500) || null;
    await leads.setJSON(key, lead);
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
};
