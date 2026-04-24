// Rate limiter backed by Upstash Redis via its REST API. Chosen over the
// `@upstash/ratelimit` npm package deliberately: the REST endpoint gives us
// exactly what we need (atomic INCR + EXPIRE) via one fetch, and skipping
// the package keeps our supply-chain surface at zero.
//
// Algorithm: fixed-window counter. Each window (e.g., 1 hour) gets its own
// Redis key keyed by the floored timestamp; the key auto-expires via EXPIRE
// so cleanup is free. Fixed-window has a known edge-case (a burst at the
// window boundary can briefly double the limit) but for abuse prevention on
// a waitlist it's more than sufficient and significantly cheaper than
// sliding-window alternatives.
//
// Env vars (configure in Vercel project settings):
//   UPSTASH_REDIS_REST_URL   — full https URL, e.g. https://us1-foo.upstash.io
//   UPSTASH_REDIS_REST_TOKEN — auth token; Upstash provides a read+write token
// If either is missing, the limiter fails open (logs a warning, allows the
// request). This is intentional — misconfiguration should not brick signups.
// Production deploys MUST have both set; a startup check and alerting
// belong in a later monitoring chunk.

function getClientIp(request) {
  // Vercel's edge sets x-forwarded-for; the leftmost entry is the original
  // client. Anything else in the chain is Vercel's infra, which we trust.
  var xff = request.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  // Fallback for local/dev contexts where the header is absent.
  return (request.socket && request.socket.remoteAddress) || "unknown";
}

// checkRateLimit runs one Upstash pipeline: INCR the bucket counter, then
// set a TTL so the key auto-expires at the end of the window. Returns
// { allowed, remaining, reason } — reason is 'ok', 'over_limit',
// 'unconfigured', or 'fail_open' (the latter two still allow the request).
async function checkRateLimit(request, config) {
  var prefix = config.prefix;
  var limit = config.limit;
  var windowSeconds = config.windowSeconds;

  var url = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    // First-run / pre-setup state. Log loudly so misconfiguration in prod
    // is visible in Vercel logs without breaking user signups.
    console.warn("rate_limit_unconfigured", { prefix: prefix });
    return { allowed: true, remaining: Infinity, reason: "unconfigured" };
  }

  var ip = getClientIp(request);
  var bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  var key = "rl:" + prefix + ":" + ip + ":" + bucket;

  try {
    var pipelineResponse = await fetch(url + "/pipeline", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, windowSeconds],
      ]),
    });

    if (!pipelineResponse.ok) {
      console.error("rate_limit_upstash_error", {
        prefix: prefix,
        status: pipelineResponse.status,
      });
      // Fail open — Redis being unavailable should not brick the signup
      // flow. The tradeoff: a determined attacker who can also DoS Redis
      // temporarily gets a grace window. Acceptable for a waitlist tier.
      return { allowed: true, remaining: limit, reason: "fail_open" };
    }

    var results = await pipelineResponse.json();
    var count = (results[0] && results[0].result) || 0;

    if (count > limit) {
      return { allowed: false, remaining: 0, reason: "over_limit" };
    }
    return { allowed: true, remaining: Math.max(0, limit - count), reason: "ok" };
  } catch (error) {
    console.error("rate_limit_fetch_failed", {
      prefix: prefix,
      message: error && error.message,
    });
    return { allowed: true, remaining: limit, reason: "fail_open" };
  }
}

module.exports = { checkRateLimit, getClientIp };
