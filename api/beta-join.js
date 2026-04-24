// POST /api/beta-join
// Proxies landing-page signups to Mailchimp's real API (PUT /lists/{id}/members/{hash})
// instead of the fire-and-forget iframe pattern. Two reasons for the switch:
//   1. We get real HTTP status codes + error bodies back — if a merge field is
//      dropped silently by Mailchimp's embedded-form endpoint (f_id-scoped
//      fields), we see it. The iframe path always looked successful.
//   2. We can accept an arbitrary set of merge fields (ROLE, REF, etc.) without
//      needing to re-embed the form in Mailchimp every time the schema changes.

const crypto = require("crypto");
const { checkRateLimit, getClientIp } = require("../lib/rateLimit.js");
const { verifyTurnstile } = require("../lib/turnstile.js");

const DEFAULT_AUDIENCE_ID = "177d7768dd";
// Budget: a real human signs up once. Allowing 5/hour leaves room for
// corrections / double-submits but blocks any sustained abuse. If a shared
// NAT (coffee shop, corp network) trips this, users can come back in an
// hour — acceptable tradeoff for a waitlist.
const RATE_LIMIT = { prefix: "beta-join", limit: 5, windowSeconds: 3600 };
const ROLE_VALUES = ["seller", "buyer", "both", "curious"];
// RFC 5321 caps an address at 254 bytes. The regex has no length bound, so
// we pre-check length to avoid forwarding absurd payloads to Mailchimp.
const EMAIL_MAX_BYTES = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REF_RE = /^[a-zA-Z0-9_-]{1,32}$/;
// Origins allowed to POST to this endpoint. Everything else (other sites,
// curl without a header, arbitrary scripts on other domains) is rejected.
// Not a full CSRF defense on its own, but filters casual scripted abuse.
const ALLOWED_ORIGINS = new Set([
  "https://aibodes.com",
  "https://www.aibodes.com",
]);

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

// Vercel's Node runtime doesn't auto-parse JSON bodies for plain Node handlers,
// so we read the stream ourselves. 64KB hard cap — a signup payload is <1KB
// in the happy path; anything bigger is either a mistake or an attack.
function readJsonBody(request) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var total = 0;
    var MAX_BYTES = 64 * 1024;
    request.on("data", function (chunk) {
      total += chunk.length;
      if (total > MAX_BYTES) {
        reject(new Error("body_too_large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", function () {
      try {
        var raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error("invalid_json"));
      }
    });
    request.on("error", reject);
  });
}

module.exports = async function betaJoin(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: "method_not_allowed" });
  }

  // Origin / Referer gate. Cheap zero-dep CSRF filter: only accept POSTs
  // from aibodes.com. Bypassable by anyone willing to forge headers, but
  // stops casual scripted abuse from other origins without any cost.
  var origin = request.headers.origin || request.headers.referer || "";
  var matched = false;
  for (var allowed of ALLOWED_ORIGINS) {
    if (origin === allowed || origin.indexOf(allowed + "/") === 0) {
      matched = true;
      break;
    }
  }
  if (!matched) {
    return sendJson(response, 403, { error: "origin_not_allowed" });
  }

  // Rate limit BEFORE touching Mailchimp or Turnstile. An attacker shouldn't
  // be able to burn through our Turnstile verify budget or Mailchimp API
  // quota just by firing bad requests. Key per-IP; returns 429 on overflow.
  var rateResult = await checkRateLimit(request, RATE_LIMIT);
  if (!rateResult.allowed) {
    response.setHeader("Retry-After", String(RATE_LIMIT.windowSeconds));
    return sendJson(response, 429, { error: "rate_limited" });
  }

  var body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return sendJson(response, 400, { error: "invalid_body" });
  }

  // Honeypot — if the bot field is non-empty, pretend success. Real users
  // can't see the field; bots fill every field they find.
  var honeypot = typeof body.bot === "string" ? body.bot.trim() : "";
  if (honeypot) {
    return sendJson(response, 200, { ok: true });
  }

  // Cloudflare Turnstile — asymmetric bot defense. Even a distributed
  // botnet that rotates through IPs to evade the rate limit can't forge
  // a valid Turnstile token. Fails CLOSED: if the token is missing,
  // malformed, or rejected by Cloudflare, we refuse. The exception is
  // the "unconfigured" branch inside verifyTurnstile (TURNSTILE_SECRET
  // env var missing) which logs and passes — that's the pre-setup state
  // and only applies until James registers the site with Cloudflare.
  var turnstileToken = typeof body.turnstileToken === "string" ? body.turnstileToken : "";
  var turnstileResult = await verifyTurnstile(turnstileToken, getClientIp(request));
  if (!turnstileResult.ok) {
    return sendJson(response, 400, { error: "turnstile_" + turnstileResult.reason });
  }

  var email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || email.length > EMAIL_MAX_BYTES || !EMAIL_RE.test(email)) {
    return sendJson(response, 400, { error: "invalid_email" });
  }

  var role = typeof body.role === "string" ? body.role.trim() : "";
  var ref = typeof body.ref === "string" ? body.ref.trim() : "";

  var mergeFields = {};
  if (ROLE_VALUES.indexOf(role) !== -1) mergeFields.ROLE = role;
  if (ref && REF_RE.test(ref)) mergeFields.REF = ref;

  var apiKey = process.env.MAILCHIMP_API_KEY;
  var audienceId = process.env.MAILCHIMP_AUDIENCE_ID || DEFAULT_AUDIENCE_ID;
  var serverPrefix =
    process.env.MAILCHIMP_SERVER_PREFIX ||
    (apiKey && apiKey.indexOf("-") !== -1 ? apiKey.split("-").pop() : null);

  if (!apiKey || !serverPrefix || !audienceId) {
    return sendJson(response, 503, { error: "unconfigured" });
  }

  // Mailchimp's upsert endpoint: PUT /lists/{list_id}/members/{subscriber_hash}
  // subscriber_hash is the MD5 of the lowercased email. This creates the
  // subscriber if missing, updates them if present. status_if_new honors the
  // list's double-opt-in setting: "subscribed" for single, "pending" for double.
  var subscriberHash = crypto.createHash("md5").update(email).digest("hex");
  var url =
    "https://" + serverPrefix + ".api.mailchimp.com/3.0/lists/" +
    audienceId + "/members/" + subscriberHash;

  // status_if_new: "pending" triggers Mailchimp's double opt-in confirmation
  // email — the address owner must click the link before the subscription
  // activates. This is the abuse gate: a hostile actor can POST arbitrary
  // email addresses here, but none of them end up on the active mailing list
  // without consent. Flip to "subscribed" only if/when we front this with a
  // Turnstile challenge and proper rate limiting.
  var payload = {
    email_address: email,
    status_if_new: "pending",
    merge_fields: mergeFields,
  };

  try {
    var mcResponse = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: "Basic " + Buffer.from("aibodes:" + apiKey).toString("base64"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!mcResponse.ok) {
      // Parse Mailchimp's error body to log only the non-PII fields. Their
      // `detail` field routinely echoes the submitted email verbatim
      // (e.g. "foo@bar.com is in a compliance state..."), so we scrub any
      // email-shaped substring out of it before logging. The class-2
      // redaction bar from aibodes-security-architecture.md §11 applies:
      // application logs must never contain user emails.
      var rawBody = await mcResponse.text();
      var safe = { status: mcResponse.status };
      try {
        var parsed = JSON.parse(rawBody);
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.title === "string") safe.title = parsed.title;
          if (typeof parsed.type === "string") safe.type = parsed.type;
          if (typeof parsed.detail === "string") {
            safe.detail = parsed.detail.replace(
              /[^\s@]+@[^\s@]+\.[^\s@]+/g,
              "[email-redacted]"
            );
          }
        }
      } catch (_) {
        // Non-JSON body (rare); log only its length, not contents.
        safe.rawLength = rawBody.length;
      }
      console.error("mailchimp_error", safe);
      return sendJson(response, 502, {
        error: "mailchimp_error",
        status: mcResponse.status,
      });
    }

    return sendJson(response, 200, { ok: true });
  } catch (error) {
    // Keep the log line free of user input.
    console.error("fetch_failed", { message: error && error.message });
    return sendJson(response, 502, { error: "fetch_failed" });
  }
};
