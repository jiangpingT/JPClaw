import crypto from "node:crypto";
import { searchWebWithOptions } from "../../dist/tools/web.js";
import { callAnthropic } from "../_shared/proactive-utils.js";

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

const SYNTHESIS_SYSTEM_PROMPT = `你是信息助手。根据搜索内容直接回答用户问题。
规则：
- 直接给出答案，不说"根据搜索结果"等
- 不提 Serper、Google、DuckDuckGo 等搜索引擎名
- 用户若问具体信息（如"哪10个赛道"）→ 直接列要点，无需附链接
- 用户若要文章列表 → 提供标题+链接
- 用中文回答，格式清晰`;

export async function run(input) {
  const payload = parseInput(input);
  const query = String(payload.query || "").trim();
  if (!query) {
    return "缺少查询关键词，请提供要搜索的内容。";
  }
  const traceId = String(payload.traceId || crypto.randomUUID().slice(0, 8));
  try {
    // Step 1: 获取搜索上下文（含 Jina 正文）
    const context = await searchWebWithOptions(query, { traceId });

    // Step 2: LLM 合成答案
    try {
      const answer = await callAnthropic(
        SYNTHESIS_SYSTEM_PROMPT,
        `${query}\n\n${context}`,
        { model: "claude-3-5-haiku-20241022", maxTokens: 1000 }
      );
      return answer;
    } catch {
      // Fallback：LLM 合成失败，返回原始上下文
      return context;
    }
  } catch (error) {
    return `搜索失败：${String(error?.message || error)}`;
  }
}
