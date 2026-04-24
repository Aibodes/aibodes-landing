// POST /api/beta-join
// Proxies landing-page signups to Mailchimp's real API (PUT /lists/{id}/members/{hash})
// instead of the fire-and-forget iframe pattern. Two reasons for the switch:
//   1. We get real HTTP status codes + error bodies back — if a merge field is
//      dropped silently by Mailchimp's embedded-form endpoint (f_id-scoped
//      fields), we see it. The iframe path always looked successful.
//   2. We can accept an arbitrary set of merge fields (ROLE, REF, etc.) without
//      needing to re-embed the form in Mailchimp every time the schema changes.

const crypto = require("crypto");

const DEFAULT_AUDIENCE_ID = "177d7768dd";
const ROLE_VALUES = ["seller", "buyer", "both", "curious"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REF_RE = /^[a-zA-Z0-9_-]{1,32}$/;

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

  var email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) {
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

  var payload = {
    email_address: email,
    status_if_new: "subscribed",
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
      var rawBody = await mcResponse.text();
      // Log the full Mailchimp error server-side (Vercel function logs capture
      // this), but surface only the HTTP status and a generic message to the
      // client so we don't leak audience IDs or API-key formats in browser.
      console.error("Mailchimp error:", mcResponse.status, rawBody);
      return sendJson(response, 502, {
        error: "mailchimp_error",
        status: mcResponse.status,
      });
    }

    return sendJson(response, 200, { ok: true });
  } catch (error) {
    console.error("beta-join fetch failed:", error && error.message);
    return sendJson(response, 502, { error: "fetch_failed" });
  }
};
