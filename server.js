import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config (all via environment variables) ----------
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'leads.db');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const OTP_MODE = process.env.OTP_MODE || 'dev'; // 'dev' prints OTP to console, 'webhook' POSTs it to OTP_WEBHOOK_URL
const OTP_WEBHOOK_URL = process.env.OTP_WEBHOOK_URL || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || '';
// WhatsApp Cloud API (Meta). Alerts go to WHATSAPP_TO, your own number, e.g. 919876543210
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const WHATSAPP_TO = (process.env.WHATSAPP_TO || '').replace(/\D/g, '');
const WHATSAPP_TEMPLATE = process.env.WHATSAPP_TEMPLATE || ''; // approved template name (needed unless you chatted with the number in the last 24h)
const WHATSAPP_TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'en';
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v23.0';
const WHATSAPP_ENABLED = Boolean(WHATSAPP_TOKEN && WHATSAPP_PHONE_NUMBER_ID && WHATSAPP_TO);

if (!ADMIN_PASSWORD) {
  console.warn('WARNING: ADMIN_PASSWORD is not set. The lead inbox is disabled until you set it.');
}

const CITIES = ['Chennai', 'Bangalore', 'Hyderabad', 'Other'];
const MACHINES = ['Coffee', 'Tea', 'Both coffee and tea', 'Not sure'];
const STATUSES = ['new', 'called', 'quoted', 'won', 'lost'];
const PHONE_RE = /^[6-9]\d{9}$/;

// ---------- database ----------
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    company TEXT,
    city TEXT NOT NULL,
    machine TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    duration_months INTEGER,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    internal_note TEXT,
    source TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
  CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
`);

const insertLead = db.prepare(`
  INSERT INTO leads (name, phone, company, city, machine, quantity, duration_months, notes, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const recentSamePhone = db.prepare(
  `SELECT id FROM leads WHERE phone = ? AND created_at > datetime('now', '-1 day') LIMIT 1`
);

// ---------- helpers ----------
const clean = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// Normalise to a bare 10-digit number: drop spaces/dashes, then a +91 / 91 prefix (only when 12 digits) or a leading 0 (only when 11 digits)
function normalizePhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// simple in-memory rate limiter: max `limit` hits per `windowMs` per key
function rateLimit({ limit, windowMs }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > limit) {
      return res.status(429).json({ error: 'Too many requests. Please try again in a few minutes.' });
    }
    next();
  };
}

// ---------- OTP (in memory, 10 minute expiry, 5 attempts) ----------
const otps = new Map(); // phone -> { hash, expires, attempts, lastSent }

async function deliverOtp(phone, code) {
  if (OTP_MODE === 'webhook' && OTP_WEBHOOK_URL) {
    const r = await fetch(OTP_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: `+91${phone}`, code, message: `Your verification code is ${code}. Valid for 10 minutes.` }),
    });
    if (!r.ok) throw new Error(`OTP webhook returned ${r.status}`);
    return;
  }
  console.log(`[DEV OTP] +91${phone} -> ${code}`);
}

// ---------- alerts ----------
// WhatsApp template parameters cannot contain newlines, tabs or long runs of spaces
const waParam = (s) => ({ type: 'text', text: String(s || '-').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 200) || '-' });

async function sendWhatsAppAlert(lead, plainText) {
  const body = WHATSAPP_TEMPLATE
    ? {
        messaging_product: 'whatsapp',
        to: WHATSAPP_TO,
        type: 'template',
        template: {
          name: WHATSAPP_TEMPLATE,
          language: { code: WHATSAPP_TEMPLATE_LANG },
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
    : { messaging_product: 'whatsapp', to: WHATSAPP_TO, type: 'text', text: { body: plainText, preview_url: false } };

  const r = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${WHATSAPP_TOKEN}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    const e = err.error || {};
    throw new Error(`WhatsApp ${r.status} code=${e.code ?? '?'} ${e.message ?? ''}`.trim());
  }
}

async function notifyNewLead(lead) {
  const text =
    `New lead #${lead.id}\n` +
    `${lead.name}${lead.company ? ` (${lead.company})` : ''}\n` +
    `Phone: +91${lead.phone}\n` +
    `City: ${lead.city}\n` +
    `Wants: ${lead.quantity} x ${lead.machine}` +
    (lead.duration_months ? ` for ${lead.duration_months} months` : '') +
    (lead.notes ? `\nNotes: ${lead.notes}` : '') +
    `\nWhatsApp: https://wa.me/91${lead.phone}`;

  const jobs = [];
  if (WHATSAPP_ENABLED) jobs.push(sendWhatsAppAlert(lead, text));
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      })
    );
  }
  if (ALERT_WEBHOOK_URL) {
    jobs.push(
      fetch(ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, lead }),
      })
    );
  }
  if (jobs.length === 0) console.log(`[LEAD ALERT]\n${text}`);
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === 'rejected') console.error('Alert failed:', r.reason?.message);
}

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  });
  next();
});

// public pages
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', extensions: ['html'] }));

app.get('/api/config', (_req, res) => res.json({ cities: CITIES, machines: MACHINES }));

// step 1: send OTP
app.post('/api/otp/send', rateLimit({ limit: 8, windowMs: 10 * 60 * 1000 }), async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number.' });

  const existing = otps.get(phone);
  if (existing && Date.now() - existing.lastSent < 30_000) {
    return res.status(429).json({ error: 'Please wait 30 seconds before requesting another code.' });
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  try {
    await deliverOtp(phone, code);
  } catch (e) {
    console.error('OTP delivery failed:', e.message);
    return res.status(502).json({ error: 'Could not send the code. Please try again.' });
  }
  otps.set(phone, { hash: sha(code), expires: Date.now() + 10 * 60 * 1000, attempts: 0, lastSent: Date.now() });
  res.json({ ok: true });
});

// step 2: submit enquiry with OTP
app.post('/api/leads', rateLimit({ limit: 10, windowMs: 10 * 60 * 1000 }), async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // honeypot: bots fill this, humans never see it

  const phone = normalizePhone(b.phone);
  const name = clean(b.name, 80);
  const company = clean(b.company, 120);
  const city = clean(b.city, 30);
  const machine = clean(b.machine, 40);
  const quantity = Number.parseInt(b.quantity, 10);
  const duration = b.duration_months === '' || b.duration_months == null ? null : Number.parseInt(b.duration_months, 10);
  const notes = clean(b.notes, 500);
  const source = clean(b.source, 60);
  const otp = clean(b.otp, 6);

  if (name.length < 2) return res.status(400).json({ error: 'Please enter your name.' });
  if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number.' });
  if (!CITIES.includes(city)) return res.status(400).json({ error: 'Please choose a city.' });
  if (!MACHINES.includes(machine)) return res.status(400).json({ error: 'Please choose a machine type.' });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
    return res.status(400).json({ error: 'Quantity must be between 1 and 500.' });
  }
  if (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 120)) {
    return res.status(400).json({ error: 'Duration must be between 1 and 120 months.' });
  }

  const rec = otps.get(phone);
  if (!rec || rec.expires < Date.now()) return res.status(400).json({ error: 'Code expired. Please request a new one.' });
  if (rec.attempts >= 5) {
    otps.delete(phone);
    return res.status(400).json({ error: 'Too many wrong attempts. Please request a new code.' });
  }
  rec.attempts += 1;
  if (!/^\d{6}$/.test(otp) || !safeEqual(sha(otp), rec.hash)) {
    return res.status(400).json({ error: 'Incorrect code.' });
  }
  otps.delete(phone);

  if (recentSamePhone.get(phone)) {
    // already captured in the last 24h: acknowledge without creating a duplicate
    return res.json({ ok: true, duplicate: true });
  }

  const info = insertLead.run(name, phone, company || null, city, machine, quantity, duration, notes || null, source || null);
  const lead = { id: Number(info.lastInsertRowid), name, phone, company, city, machine, quantity, duration_months: duration, notes };
  notifyNewLead(lead).catch((e) => console.error('notify error:', e.message));
  res.json({ ok: true });
});

// ---------- admin ----------
function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).send('Admin is disabled: set ADMIN_PASSWORD.');
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
    if (safeEqual(user, ADMIN_USER) && safeEqual(rest.join(':'), ADMIN_PASSWORD)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Lead inbox"');
  res.status(401).send('Authentication required');
}

app.get('/admin', adminAuth, (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'admin.html')));

app.get('/api/admin/leads', adminAuth, (req, res) => {
  const status = clean(req.query.status, 20);
  const city = clean(req.query.city, 30);
  const where = [];
  const args = [];
  if (STATUSES.includes(status)) { where.push('status = ?'); args.push(status); }
  if (CITIES.includes(city)) { where.push('city = ?'); args.push(city); }
  const sql = `SELECT * FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`;
  res.json({ leads: db.prepare(sql).all(...args), statuses: STATUSES });
});

app.patch('/api/admin/leads/:id', adminAuth, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const status = clean(req.body.status, 20);
  const note = req.body.internal_note === undefined ? undefined : clean(req.body.internal_note, 500);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Bad status' });
  const row = db.prepare('SELECT id FROM leads WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (status) db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, id);
  if (note !== undefined) db.prepare('UPDATE leads SET internal_note = ? WHERE id = ?').run(note || null, id);
  res.json({ ok: true });
});

app.get('/api/admin/export.csv', adminAuth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM leads ORDER BY id DESC').all();
  const cols = ['id', 'created_at', 'name', 'phone', 'company', 'city', 'machine', 'quantity', 'duration_months', 'notes', 'status', 'internal_note', 'source'];
  // prefix cells that start with formula characters so Excel/Sheets do not execute them
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="leads.csv"' });
  res.send(csv);
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Lead capture running on http://localhost:${PORT}  (inbox: /admin)`));
