# Security Policy

Aibödes is being built as the agent-free real estate transaction operating system — long-term, that means handling identity, financial, and home-profile data at national scale. The security bar at every phase is a Series-A-CISO review, not "what fits in a waitlist."

This policy covers the **landing site** (`aibodes.com` / `www.aibodes.com`, this repository). Product-app security is governed separately by `aibodes-security-architecture.md` in the main workspace.

## Reporting a vulnerability

Please report suspected security issues privately.

- **Email:** security@aibodes.com
- **security.txt:** https://www.aibodes.com/.well-known/security.txt
- **Response target:** acknowledgment within 72 hours; triage within 7 days.

Please do **not** file a public GitHub issue for security reports. If the vulnerability is high-severity, include a proof-of-concept and your preferred contact.

## Out of scope

- Rate-limit enforcement by individual IP on a shared network (coffee shop, corporate NAT). Treat as expected behavior.
- Email deliverability complaints — direct those to hello@ or to Mailchimp support.
- Social-engineering or phishing attempts against individual team members.

## Current posture

The landing site enforces the following at the time of writing:

| Control | State | Notes |
|---|---|---|
| HTTPS everywhere | Enforced | Vercel serves HTTPS; HSTS with `preload` directive. |
| Content-Security-Policy | Strict | `default-src 'self'`, `frame-ancestors 'none'`, `base-uri 'self'`, `object-src 'none'`. |
| X-Frame-Options | `DENY` | Layered with `frame-ancestors 'none'` for clickjacking defense. |
| Origin/Referer allowlist | Enforced on `/api/beta-join` | Only aibodes.com origins accepted. |
| Honeypot field | Enforced | Silent drop on non-empty honeypot. |
| Email length + format validation | Enforced | 254-byte RFC 5321 cap; regex check. |
| Role / Referral allowlists | Enforced | `ROLE_VALUES = [seller, buyer, both, curious]`; `REF` regex `/^[a-zA-Z0-9_-]{1,32}$/`. |
| Mailchimp double opt-in | Enforced | `status_if_new: pending` — no address is subscribed without consent. |
| Rate limiting (Upstash Redis) | Code live, needs env vars | `/api/beta-join` 5/hour/IP; `/api/beta-count` 120/min/IP. Fails open when env vars absent; logs a warning. |
| Cloudflare Turnstile | Code live, needs site key + secret | Invisible managed-mode bot challenge. Fails open when env vars absent; logs a warning. |
| Log redaction | Enforced | Mailchimp error bodies are parsed for `status`/`title`/`detail` only; never logged verbatim. |
| Secrets in code | None | All credentials in Vercel env vars; no `.env` files committed. |
| Supply chain | Zero npm deps on the landing site | Only Node built-ins (`crypto`) and platform `fetch`. |
| Responsible disclosure | Documented | `/.well-known/security.txt` + this file. |

## Pending — activation checklist

Two controls require one-time external setup before they start enforcing.

### 1. Upstash Redis (rate limiting)

1. Sign up at https://console.upstash.com (free tier covers this scale).
2. Create a Redis database in the region nearest Vercel's edge (us-east-1 is fine for most cases).
3. Copy the **REST URL** and **REST Token** from the database's "REST" tab.
4. Add to Vercel project settings → Environment Variables (Production + Preview):
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
5. Redeploy. The next request will start counting against the limit; Vercel logs will stop showing `rate_limit_unconfigured`.

### 2. Cloudflare Turnstile (bot defense)

1. Sign up at https://dash.cloudflare.com (free tier).
2. Go to **Turnstile** → **Add site**. Domain: `aibodes.com` (and `www.aibodes.com` as additional). Widget mode: **Managed**. Pre-clearance: **Off**.
3. Cloudflare issues a **Site Key** (public) and a **Secret Key** (server-side only).
4. In `index.html`, replace the literal string `TURNSTILE_SITEKEY_PLACEHOLDER` with the Site Key, commit, and push.
5. Add to Vercel project settings → Environment Variables:
   - `TURNSTILE_SECRET` = the Secret Key.
6. Redeploy. The next signup will be verified; Vercel logs will stop showing `turnstile_unconfigured`.

## Roadmap — controls not yet implemented

These are tracked for the next security chunk, not the current one. Priority in rough order:

- **Monitoring & alerting** on Vercel function error rates, Mailchimp 4xx/5xx rates, Turnstile rejection rates, rate-limit 429 rates. Sentry or Vercel's built-in alerts.
- **Audit logging** for every signup (IP, UA, origin, timestamp, outcome) to a durable store. Required for abuse investigation and future compliance.
- **Privacy policy and Terms** at `/privacy` and `/terms`. Required under GDPR and CCPA even for a waitlist.
- **Cloudflare WAF** in front of Vercel if Turnstile alone proves insufficient. Can drop known bad UAs and TOR exits at edge.
- **DNSSEC** on the `aibodes.com` zone.
- **CAA records** restricting which CAs can issue certs for `aibodes.com`.
- **Bug bounty** program once product surface stabilizes.
- **Secret rotation policy** — document and automate rotation of `MAILCHIMP_API_KEY`, `TURNSTILE_SECRET`, `UPSTASH_REDIS_REST_TOKEN` at a fixed cadence.

## Governing documents

The landing site is one surface. Product-level security decisions live in the main workspace's governing docs:

- `aibodes-foundation.md` — core principles, including "trust is the product."
- `aibodes-security-architecture.md` — data classification, minimization, tokenization posture for Class 2–4 data.
- `aibodes-product-engineering-standard.md` — bar for visible product work (deterministic core, server-side authz, senior-engineer quality).
- `aibodes-security-findings-2026-04-22.md` — the April 22 read-only review and remediation plan.

## Data handled by this surface

The landing site collects only:

- **Email address** (Class 2 personal data) — stored by Mailchimp under their processor agreement.
- **Role** — an enum from `{seller, buyer, both, curious}`. Class 1.
- **Referral token** — short alphanumeric, ≤32 chars. Class 1.

No Class 3 or Class 4 data is accepted on this surface. Any future expansion here requires a revisit of this policy and `aibodes-security-architecture.md`.
