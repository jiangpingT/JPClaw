import crypto from "node:crypto";
import { searchWebWithOptions } from "../../dist/tools/web.js";

function parseInput(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
  return { query: text };
}

async function searchBrave(query, count) {
  const apiKey = String(process.env.BRAVE_SEARCH_API_KEY || "").trim();
  if (!apiKey) return null;
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.max(1, Number(count || 5))));
  const resp = await fetch(String(url), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey
    }
  });
  if (!resp.ok) {
    throw new Error(`brave_http_${resp.status}`);
  }
  const json = await resp.json();
  const results = Array.isArray(json?.web?.results) ? json.web.results : [];
  return results.map((x) => ({
    title: String(x?.title || ""),
    url: String(x?.url || ""),
    snippet: String(x?.description || "")
  }));
}

export async function run(input) {
  const payload = parseInput(input);
  const query = String(payload.query || "").trim();
  if (!query) {
    return JSON.stringify({ ok: false, error: "missing_query" }, null, 2);
  }
  const traceId = String(payload.traceId || crypto.randomUUID().slice(0, 8));
  const provider = String(payload.provider || "auto").toLowerCase();
  try {
    if (provider === "brave" || provider === "auto") {
      const braveRows = await searchBrave(query, payload.count);
      if (Array.isArray(braveRows) && braveRows.length) {
        return JSON.stringify(
          {
            ok: true,
            traceId,
            query,
            provider: "brave",
            count: braveRows.length,
            rows: braveRows
          },
          null,
          2
        );
      }
    }
    const result = await searchWebWithOptions(query, { traceId });
    return JSON.stringify(
      {
        ok: true,
        traceId,
        query,
        provider: "builtin",
        result: String(result || "").trim()
      },
      null,
      2
    );
  } catch (error) {
    return JSON.stringify(
      {
        ok: false,
        traceId,
        query,
        error: String(error?.message || error)
      },
      null,
      2
    );
  }
}
