const DEFAULT_AUDIENCE_ID = "177d7768dd";

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

module.exports = async function betaCount(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return sendJson(response, 405, { error: "method_not_allowed" });
  }

  var fallbackCount = parseNonNegativeInteger(process.env.BETA_SIGNUP_COUNT_FALLBACK);
  var apiKey = process.env.MAILCHIMP_API_KEY;
  var audienceId = process.env.MAILCHIMP_AUDIENCE_ID || DEFAULT_AUDIENCE_ID;
  var serverPrefix =
    process.env.MAILCHIMP_SERVER_PREFIX ||
    (apiKey && apiKey.indexOf("-") !== -1 ? apiKey.split("-").pop() : null);

  if (!apiKey || !serverPrefix || !audienceId) {
    return sendJson(
      response,
      fallbackCount === null ? 503 : 200,
      {
        count: fallbackCount,
        source: fallbackCount === null ? "unconfigured" : "fallback",
      },
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
      return sendJson(
        response,
        fallbackCount === null ? 502 : 200,
        {
          count: fallbackCount,
          source: fallbackCount === null ? "mailchimp_error" : "fallback",
        },
        "s-maxage=60, stale-while-revalidate=300"
      );
    }

    var payload = await mailchimpResponse.json();
    var count = Number.isFinite(payload.total_items) ? payload.total_items : fallbackCount;

    return sendJson(
      response,
      count === null ? 502 : 200,
      {
        count: count,
        source: count === payload.total_items ? "mailchimp" : "fallback",
      },
      "s-maxage=300, stale-while-revalidate=3600"
    );
  } catch (error) {
    return sendJson(
      response,
      fallbackCount === null ? 502 : 200,
      {
        count: fallbackCount,
        source: fallbackCount === null ? "fetch_failed" : "fallback",
      },
      "s-maxage=60, stale-while-revalidate=300"
    );
  }
};
