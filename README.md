# Buy-lead MVP: coffee & tea vending machine rentals

A small enquiry funnel for VGS Enterprises (Chennai, Bangalore, Hyderabad). Visitors fill a short form, verify their phone with an OTP, and you get an instant WhatsApp alert plus a lead inbox.

## Run locally

Needs Node 22.13 or newer.

    npm install
    cp .env.example .env        # then edit .env
    node --env-file=.env server.js

- Enquiry page: http://localhost:3000
- Lead inbox: http://localhost:3000/admin (login uses ADMIN_USER / ADMIN_PASSWORD)

In `OTP_MODE=dev` the OTP prints in the server console. Use that for testing only.

## Deploy on Render

1. Put this folder in a GitHub repo (`.env` and `leads.db` are already git-ignored).
2. In Render: New > Blueprint, pick the repo. `render.yaml` creates the web service and a 1 GB disk for the leads database.
3. When asked, fill the secret values (see below). At minimum `ADMIN_PASSWORD`.
4. Open the Render URL, submit a test lead, and check `/admin`.

The disk needs a paid instance (starter). On the free plan the database is wiped on every restart and the service sleeps when idle, so do not use it for real leads.

Keep a single instance. OTP codes are held in memory.

## WhatsApp alerts to your number (Meta WhatsApp Cloud API)

1. Create a Meta developer app (type Business) and add the WhatsApp product. Meta gives you a test number and a phone number ID.
2. Add your own number as a recipient (test phase), or complete business verification to message freely in production.
3. Create a permanent access token: Business Settings > System Users > add a system user > generate a token with `whatsapp_business_messaging` permission. The 24 hour token on the API setup page expires and will break alerts.
4. Create a message template named `new_lead_alert`, category Utility, language English, with this body (exactly 4 variables, in this order):

       New lead: {{1}}. Phone {{2}}, city {{3}}. Wants {{4}}.

   Meta must approve it, usually within a day.
5. Set these in Render: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TO` (your number with country code, like 919876543210), `WHATSAPP_TEMPLATE=new_lead_alert`.

Why a template: WhatsApp only allows free-form messages within 24 hours of the recipient last messaging that number. A new lead can arrive any time, so an approved template is required. If you leave `WHATSAPP_TEMPLATE` empty, the app sends plain text, which only works if you message the business number at least once a day.

If an alert fails, the server log shows the WhatsApp error code, and the lead is still saved in the inbox.

## Other settings

- OTP SMS: set `OTP_MODE=webhook` and `OTP_WEBHOOK_URL` to an endpoint that sends the SMS (MSG91, Twilio, Fast2SMS or a small adapter). The server POSTs `{phone, code, message}`. India SMS needs DLT template registration.
- Telegram or any webhook alerts work alongside WhatsApp (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, `ALERT_WEBHOOK_URL`).

## What it does

- Validates Indian mobile numbers; OTP expires in 10 minutes, 5 attempts, 30 second resend gap.
- Rate limits per IP, honeypot field against bots, one lead per phone per 24 hours.
- Inbox: filter by status and city, call and WhatsApp links, status (new, called, quoted, won, lost), internal notes, CSV export.
- Tracks traffic source from `?utm_source=` or `?src=` in the link.

## Files

- `server.js` API, OTP, alerts, admin
- `public/index.html` enquiry form
- `admin/admin.html` lead inbox (served only after login)
- `render.yaml` Render blueprint
