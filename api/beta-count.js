const DEFAULT_AUDIENCE_ID = "177d7768dd";
const DEFAULT_PUBLIC_THRESHOLD = 1000;

function sendJson(response, statusCode, payload, cacheControl) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (cacheControl) {
    response.setHeader("Cache-Control", cacheControl);
  }
  response.end(JSON.stringify(payload));
}

function parseNonNegativeInteger(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  var parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function sendCountJson(response, statusCode, count, source, publicThreshold, cacheControl) {
  if (count !== null && count < publicThreshold) {
    return sendJson(
      response,
      200,
      {
        count: null,
        source: "below_threshold",
      },
      cacheControl
    );
  }

  return sendJson(
    response,
    statusCode,
    {
      count: count,
      source: source,
    },
    cacheControl
  );
}

module.exports = async function betaCount(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return sendJson(response, 405, { error: "method_not_allowed" });
  }

  var fallbackCount = parseNonNegativeInteger(process.env.BETA_SIGNUP_COUNT_FALLBACK);
  var configuredPublicThreshold = parseNonNegativeInteger(
    process.env.BETA_SIGNUP_COUNT_PUBLIC_THRESHOLD
  );
  var publicThreshold =
    configuredPublicThreshold === null ? DEFAULT_PUBLIC_THRESHOLD : configuredPublicThreshold;
  var apiKey = process.env.MAILCHIMP_API_KEY;
  var audienceId = process.env.MAILCHIMP_AUDIENCE_ID || DEFAULT_AUDIENCE_ID;
  var serverPrefix =
    process.env.MAILCHIMP_SERVER_PREFIX ||
    (apiKey && apiKey.indexOf("-") !== -1 ? apiKey.split("-").pop() : null);

  if (!apiKey || !serverPrefix || !audienceId) {
    return sendCountJson(
      response,
      fallbackCount === null ? 503 : 200,
      fallbackCount,
      fallbackCount === null ? "unconfigured" : "fallback",
      publicThreshold,
      "s-maxage=60, stale-while-revalidate=300"
    );
  }

  var url = new URL(
    "https://" + serverPrefix + ".api.mailchimp.com/3.0/lists/" + audienceId + "/members"
  );
  url.searchParams.set("count", "1");
  url.searchParams.set("status", "subscribed");
  url.searchParams.set("fields", "total_items");

  try {
    var mailchimpResponse = await fetch(url, {
      headers: {
        Authorization: "Basic " + Buffer.from("aibodes:" + apiKey).toString("base64"),
      },
    });

    if (!mailchimpResponse.ok) {
      return sendCountJson(
        response,
        fallbackCount === null ? 502 : 200,
        fallbackCount,
        fallbackCount === null ? "mailchimp_error" : "fallback",
        publicThreshold,
        "s-maxage=60, stale-while-revalidate=300"
      );
    }

    var payload = await mailchimpResponse.json();
    var count = Number.isFinite(payload.total_items) ? payload.total_items : fallbackCount;

    return sendCountJson(
      response,
      count === null ? 502 : 200,
      count,
      count === payload.total_items ? "mailchimp" : "fallback",
      publicThreshold,
      "s-maxage=300, stale-while-revalidate=3600"
    );
  } catch (error) {
    return sendCountJson(
      response,
      fallbackCount === null ? 502 : 200,
      fallbackCount,
      fallbackCount === null ? "fetch_failed" : "fallback",
      publicThreshold,
      "s-maxage=60, stale-while-revalidate=300"
    );
  }
};
