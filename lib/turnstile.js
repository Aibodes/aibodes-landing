// Cloudflare Turnstile server-side verification. Turnstile is Cloudflare's
// reCAPTCHA alternative — privacy-respecting (no cookie farming, no
// third-party tracking), free at any scale, and invisible to real humans
// in 'managed' mode. It aligns with the foundation principle #5 ("trust
// is the product") in a way reCAPTCHA v3 does not.
//
// Client flow: index.html loads the Turnstile script from
// challenges.cloudflare.com, renders an invisible widget, and captures a
// token. The token is sent with every /api/beta-join POST.
//
// Server flow: this module POSTs the token to Cloudflare's siteverify
// endpoint along with the TURNSTILE_SECRET env var. Cloudflare returns
// { success: true, hostname, challenge_ts, ... } or { success: false,
// "error-codes": [...] }. We only accept success === true.
//
// Env var:
//   TURNSTILE_SECRET — Cloudflare "Secret Key" from the Turnstile dashboard
// If TURNSTILE_SECRET is not set, verification is skipped (fail-open) so
// initial deploys work before James has registered the site with Cloudflare.
// Production deploys MUST have this set; the missing-secret branch logs a
// warning on every request so the condition is visible.

var VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

async function verifyTurnstile(token, remoteIp) {
  var secret = process.env.TURNSTILE_SECRET;

  if (!secret) {
    console.warn("turnstile_unconfigured");
    return { ok: true, reason: "unconfigured" };
  }

  if (!token || typeof token !== "string" || token.length < 20 || token.length > 2048) {
    // Cloudflare tokens are ~300-600 chars in practice; a tight range
    // rejects obvious garbage before the siteverify round-trip.
    return { ok: false, reason: "invalid_token" };
  }

  var body = new URLSearchParams();
  body.append("secret", secret);
  body.append("response", token);
  if (remoteIp) body.append("remoteip", remoteIp);

  try {
    var cfResponse = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!cfResponse.ok) {
      console.error("turnstile_http_error", { status: cfResponse.status });
      // Fail CLOSED when Turnstile is down — this is the asymmetric defense
      // layer, and if we fail-open here a sustained DoS against Cloudflare
      // (unlikely but possible) would let an attacker bypass the CAPTCHA.
      return { ok: false, reason: "verify_failed" };
    }

    var result = await cfResponse.json();
    if (result && result.success === true) {
      return { ok: true, reason: "verified" };
    }

    // Log the error codes Cloudflare returned; they're small strings like
    // 'invalid-input-response' or 'timeout-or-duplicate', not PII.
    console.warn("turnstile_rejected", {
      errorCodes: (result && result["error-codes"]) || [],
    });
    return { ok: false, reason: "rejected" };
  } catch (error) {
    console.error("turnstile_fetch_failed", {
      message: error && error.message,
    });
    return { ok: false, reason: "verify_failed" };
  }
}

module.exports = { verifyTurnstile };
