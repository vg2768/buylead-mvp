# Buy-lead site on Netlify, leads to WhatsApp

Enquiry page for coffee and tea vending machine rentals (Chennai, Bangalore, Hyderabad). A visitor fills the form, verifies their phone with an OTP, and the lead is saved and sent to your WhatsApp. No server to manage, and the free Netlify plan is enough to start.

## How it is built

- `public/index.html` is the enquiry page.
- `public/admin/index.html` is the lead inbox, protected by a password (`ADMIN_PASSWORD`).
- `netlify/functions/` has three serverless functions: `otp-send`, `lead`, `admin`.
- Leads are stored in Netlify Blobs (built into Netlify, no setup needed).
- OTPs are stateless: the server gives the browser a signed token and re-checks the typed code against it, so nothing needs to live in memory between requests. That is what lets this run on serverless.

## Deploy

1. Put this folder in a GitHub repo (`.env` is git-ignored).
2. Netlify: Add new site > Import an existing project > pick the repo. The settings in `netlify.toml` are picked up automatically.
3. Site configuration > Environment variables: add `OTP_SECRET` and `ADMIN_PASSWORD` first (see `.env.example`). Redeploy after changing variables.
4. Open your site, submit a test lead, then open `/admin/` and log in.

Do not use drag-and-drop deploys: they skip the function build, so the lead capture would not work. Deploy from GitHub, or with the Netlify CLI (`netlify deploy --prod`).

## WhatsApp alerts to your number (Meta WhatsApp Cloud API)

1. Create a Meta developer app (type Business) and add the WhatsApp product. You get a test number and a phone number ID.
2. Add your own number as a recipient (test phase), or complete business verification to go live.
3. Create a permanent access token: Business Settings > System Users > add a system user > generate a token with `whatsapp_business_messaging`. The 24 hour token on the API setup page expires and will silently stop alerts.
4. Create a message template named `new_lead_alert`, category Utility, language English, with exactly 4 variables in this order:

       New lead: {{1}}. Phone {{2}}, city {{3}}. Wants {{4}}.

   Meta must approve it, usually within a day.
5. In Netlify set `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TO` (your number with country code, for example 919876543210) and `WHATSAPP_TEMPLATE=new_lead_alert`.

Why a template: WhatsApp only allows free-form messages within 24 hours of the recipient last messaging the business number. A new lead can arrive at any hour, so an approved template is needed. If `WHATSAPP_TEMPLATE` is empty, plain text is sent, which only works if you message the business number at least once a day.

If an alert fails, the function log shows the WhatsApp error code, and the lead is still saved in the inbox.

## Customer OTP by SMS

Set `OTP_MODE=webhook` and `OTP_WEBHOOK_URL` to an endpoint that sends the SMS (MSG91, Twilio, Fast2SMS or a small adapter). It receives `{phone, code, message}` with phone as `+91...`. India SMS needs DLT template registration with your provider. Until then, `OTP_MODE=dev` writes the code to the Netlify function log, which is for testing only: real visitors will never receive a code.

## Protection built in

- Phone validation, OTP expiry (10 minutes), 5 attempts per code, a code can be used once, 30 second resend gap.
- Per-IP and per-phone limits, a hidden bot trap field, one lead per phone per 24 hours.
- Inbox login locks an IP out after 10 wrong passwords.

## Test

    npm install
    npm test

Runs 26 checks on the functions with an in-memory store and a stubbed WhatsApp API (nothing is sent). It does not touch real Netlify Blobs or Meta, so do one live test lead after deploying.

## Not included yet

CSV export from the inbox, automatic WhatsApp replies to the visitor, and a reminder for leads left on "new". The Render version (`buylead-mvp`) has CSV export.
