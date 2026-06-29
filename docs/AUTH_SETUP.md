# Email Sign-in Setup (Magic Links)

This is the step-by-step guide to turn on real, deliver-to-anyone email sign-in for
hosting rooms. Follow it once you've picked and registered a domain.

> **Current state:** Hosting a room is **open** (no sign-in) until you configure an
> email provider. The whole auth system is already built and idle — finishing this
> guide flips it on. No code changes are needed; it's all configuration.

---

## How the auth gate behaves

`REQUIRE_HOST_AUTH` controls whether hosting a room needs a signed-in account
(joining a room **never** needs sign-in):

| `REQUIRE_HOST_AUTH` | Behavior |
|---|---|
| unset (default) | Required **only if** an email provider is configured. So today (no email) → hosting is open. Once you add `RESEND_API_KEY` → it auto-gates. |
| `true` | Always require sign-in to host. |
| `false` | Never require sign-in (open hosting), even with email configured. |

While building other features, just leave it unset — you'll keep open hosting until
you finish the steps below.

---

## Step 1 — Register a domain

You need a domain you can add DNS records to (required by every email provider to
prove you own the "from" address — there's no way around it for sending to arbitrary
recipients).

Recommended registrar: **[Cloudflare](https://dash.cloudflare.com)** (at-cost pricing,
no renewal hikes, DNS built in). Alternative: **[Porkbun](https://porkbun.com)**.

**Strategy for a multi-game platform:** buy ONE umbrella brand domain (e.g.
`yourbrand.com` / `.gg` / `.games`), not one per game. Host each game on a subdomain
(`wordwars.yourbrand.com`, `chess.yourbrand.com`). Verifying this one domain in
Resend then covers email for **every** game you add later.

---

## Step 2 — Create a Resend account + API key

1. Sign up at [resend.com](https://resend.com) (free tier: 3,000 emails/month).
2. **API Keys → Create API Key** → copy the key (starts with `re_…`).

---

## Step 3 — Verify your domain in Resend

1. Resend dashboard → **Domains → Add Domain** → enter your domain (e.g. `yourbrand.com`).
2. Resend shows a set of **DNS records** generated for your domain (a few `TXT`
   records for DKIM/SPF, sometimes an `MX` on a `send.` subdomain).
3. Go to your registrar's **DNS settings** and add each record exactly (Type,
   Name/Host, Value). If you registered with Cloudflare, add them right there.
4. (Recommended) Add a DMARC record too — a `TXT` at `_dmarc.yourbrand.com` with
   value `v=DMARC1; p=none;`. Improves inbox placement so links don't hit spam.
5. Back in Resend → **Domains → Verify**. DNS can take minutes to a couple hours to
   propagate; status flips to **Verified** when ready.

> Until your domain is verified you can only use Resend's test sender
> `onboarding@resend.dev`, which **only delivers to the email that owns your Resend
> account**. Verifying the domain is what unlocks sending to everyone.

---

## Step 4 — Set environment variables (Railway → Variables)

```
RESEND_API_KEY=re_your_api_key_here
MAIL_FROM=WordWars <noreply@yourbrand.com>     # must be @ your VERIFIED domain
PUBLIC_BASE_URL=https://your-app.up.railway.app  # used to build the magic-link URL
REQUIRE_HOST_AUTH=true                          # optional: force the gate on
```

Notes:
- With `RESEND_API_KEY` set, the Resend HTTP API is used. SMTP (below) is only a
  fallback if you ever prefer it.
- `REQUIRE_HOST_AUTH=true` is optional — once email is configured the gate turns on
  automatically. Set it explicitly if you want to be unambiguous.

### SMTP alternative (instead of the Resend API)

If you'd rather use SMTP (Resend SMTP, SendGrid, Mailgun, Gmail, etc.), leave
`RESEND_API_KEY` unset and configure these instead:

```
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=resend                 # for Resend SMTP the username is literally "resend"
SMTP_PASS=re_your_api_key_here   # your Resend API key
SMTP_FROM=WordWars <noreply@yourbrand.com>
```

---

## Step 5 — Deploy & verify

1. Redeploy with the new variables.
2. In the logs you should see:
   - `mail_provider provider=resend …`
   - `host_auth_policy requireHostAuth=true …`
3. On the site → **Create a room** → you'll see the sign-in gate.
4. Enter your email → you should receive the magic link → click it → you're signed in
   and can create rooms.
5. If a send fails, the logs show `resend_send_failed` with Resend's exact error
   (invalid key, unverified sender, etc.) — quick to debug.

---

## Step 6 (later) — Add Google sign-in

The "Sign in with Google" button is a placeholder. To enable it:
1. Create an OAuth **Client ID** in Google Cloud Console; add your domain to the
   authorized JavaScript origins.
2. Ask to wire Google Identity Services token verification into `auth.js`
   (server-side verification of the ID token) and activate the button.

---

## Quick reference — all auth/email env vars

| Variable | Purpose |
|---|---|
| `RESEND_API_KEY` | Resend HTTP API key (preferred email path). |
| `MAIL_FROM` | "From" address — must be on your verified domain (or `onboarding@resend.dev` for testing). |
| `PUBLIC_BASE_URL` | Base URL used to build magic-link URLs (defaults to request host). |
| `REQUIRE_HOST_AUTH` | `true`/`false` to force the host-auth gate; unset = on only when email is configured. |
| `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM` | SMTP fallback if not using the Resend API. |
| `REDIS_URL` | Persists accounts/sessions (and game state) across restarts. Recommended in production. |
