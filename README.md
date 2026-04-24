# Aibödes Landing Page

Static landing page for `aibodes.com`, deployed on Vercel.

## Beta Signup Counter

The landing page reads `/api/beta-count` to show the current beta audience size without exposing Mailchimp credentials in browser code.

Required Vercel environment variable:

- `MAILCHIMP_API_KEY` — server-side Mailchimp Marketing API key.

Optional Vercel environment variables:

- `MAILCHIMP_AUDIENCE_ID` — Mailchimp audience/list ID. Defaults to the audience ID already used by the embedded signup form.
- `MAILCHIMP_SERVER_PREFIX` — Mailchimp datacenter prefix such as `us11`. If omitted, the API route derives it from the suffix of `MAILCHIMP_API_KEY`.
- `BETA_SIGNUP_COUNT_FALLBACK` — non-secret fallback number to render if Mailchimp is temporarily unavailable.

Do not put the Mailchimp API key in `index.html`; it must stay server-side.

## Search Indexing

This repo includes:

- `robots.txt` — allows crawlers and points to the sitemap.
- `sitemap.xml` — lists the canonical homepage URL.
- HTML metadata, canonical tags, Open Graph/Twitter metadata, and JSON-LD organization/site data in `index.html`.

After deployment, verify `https://www.aibodes.com/` in Google Search Console, submit `https://www.aibodes.com/sitemap.xml`, and use URL Inspection for the homepage. Google can take days or weeks to reflect changes, and ranking first is not guaranteed by technical SEO alone; the site still needs useful content, real links, and time for crawling.
