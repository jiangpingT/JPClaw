import { log } from "../shared/logger.js";
import { exec } from "node:child_process";
import { recordMetric } from "../shared/metrics.js";
import { safePromiseAll } from "../shared/async-utils.js";
import { validateUrl } from "../shared/security-utils.js";

type DuckResponse = {
  AbstractText?: string;
  AbstractURL?: string;
  Heading?: string;
  RelatedTopics?: Array<{
    Text?: string;
    FirstURL?: string;
    Topics?: Array<{ Text?: string; FirstURL?: string }>;
  }>;
};

type NewsItem = {
  title: string;
  link: string;
  pubDate?: string;
  source: string;
  description?: string;
};

export async function searchWeb(query: string): Promise<string> {
  return searchWebWithOptions(query);
}

export async function searchWebWithOptions(
  query: string,
  options?: { traceId?: string }
): Promise<string> {
  const q = query.trim();
  if (!q) return "请输入要查询的关键词，例如：/web 今日 AI 新闻";
  const traceId = options?.traceId;
  if (traceId) {
    log("info", "web.search.start", { traceId, query: q });
  }
  const startedAt = Date.now();

  if (isWeatherQuery(q)) {
    let out = "";
    let ok = false;
    try {
      out = await searchWeather(q);
      ok = Boolean(out.trim());
    } finally {
      recordMetric("web.search", {
        ok,
        durationMs: Date.now() - startedAt,
        meta: { mode: "weather" }
      });
    }
    if (traceId) {
      log("info", "web.search.done", { traceId, mode: "weather", ok: Boolean(out.trim()) });
    }
    return out;
  }

  let out = "";
  let ok = false;
  try {
    out = await searchGeneral(q);
    ok = Boolean(out.trim());
  } finally {
    recordMetric("web.search", {
      ok,
      durationMs: Date.now() - startedAt,
      meta: { mode: "general" }
    });
  }
  if (traceId) {
    log("info", "web.search.done", { traceId, mode: "general", ok: Boolean(out.trim()) });
  }
  return out;
}

async function searchGeneral(query: string): Promise<string> {
  if (isNewsQuery(query)) {
    const news = await searchNewsWithSummary(query);
    if (news) return news;
  }

  const candidates = buildGeneralCandidates(query);
  const attempts: string[] = [];
  for (const q of candidates) {
    attempts.push(q);
    const result = await searchDuck(q);
    if (result) {
      return formatStructuredResult({
        title: `检索结果（关键词：${normalizeSearchPhrase(query)}）`,
        overview: "已获取到公开信息并完成摘要整理。",
        points: result
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 6),
        confidence: "中"
      });
    }
  }

  // 给出更有用的建议
  const suggestions = [
    `已尝试关键词：${attempts.join(" | ")}`,
    "💡 提示：当前使用DuckDuckGo API，对某些企业人物信息覆盖有限",
    "建议：",
    "1. 配置 BRAVE_SEARCH_API_KEY 环境变量获取更好的搜索结果",
    "2. 或者告诉我具体要查的官网/公司网站，我可以直接抓取"
  ];

  return formatStructuredResult({
    title: `检索结果（关键词：${normalizeSearchPhrase(query)}）`,
    overview: "已执行多轮检索，但当前公开结果仍不够清晰。",
    points: suggestions,
    confidence: "低"
  });
}

async function searchNewsWithSummary(query: string): Promise<string | null> {
  const candidates = buildNewsCandidates(query);
  const targetPeople = extractPersonTargets(query);
  const merged: NewsItem[] = [];
  for (const q of candidates) {
    // P0-1修复: 使用 safePromiseAll 添加超时保护（15秒，因为是外部API调用）
    const results = await safePromiseAll([searchGoogleNewsRss(q), searchBingNewsRss(q)], 15000);
    const google = results[0].status === 'fulfilled' ? results[0].value : [];
    const bing = results[1].status === 'fulfilled' ? results[1].value : [];
    merged.push(...google, ...bing);
    if (merged.length >= 8) break;
  }

  const deduped = dedupeNews(merged).slice(0, 16);
  const ranked = rankNewsByTargets(deduped, targetPeople).slice(0, 8);
  if (ranked.length === 0) return null;
  const overview = buildNewsOverview(ranked);
  const quality = scoreNewsQuality(ranked, targetPeople);

  const summary = [
    `检索摘要（关键词：${normalizeSearchPhrase(query)}）`,
    ...(targetPeople.length > 0 ? [`人物聚焦：${targetPeople.join("、")}`] : []),
    "摘要概述：",
    ...overview.map((x) => `- ${x}`),
    "",
    "关键信息：",
    ...ranked.slice(0, 5).map((item) => {
      const when = item.pubDate ? ` | ${toShortDate(item.pubDate)}` : "";
      return `- ${item.title}${when}`;
    }),
    "",
    `质量评分：${quality.score}/100（${quality.level}）`,
    `置信度：${quality.confidence}（多源新闻聚合，仍需以一手公告为准）`,
    "（需要来源链接时你告诉我，我再单独发）"
  ];
  return summary.join("\n");
}

async function searchGoogleNewsRss(query: string): Promise<NewsItem[]> {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", query);
  url.searchParams.set("hl", "zh-CN");
  url.searchParams.set("gl", "CN");
  url.searchParams.set("ceid", "CN:zh-Hans");
  return parseRssNews(await runCurl(url.toString()).catch(() => ""), "GoogleNews");
}

async function searchBingNewsRss(query: string): Promise<NewsItem[]> {
  const url = new URL("https://www.bing.com/news/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "rss");
  return parseRssNews(await runCurl(url.toString()).catch(() => ""), "BingNews");
}

function parseRssNews(xml: string, source: string): NewsItem[] {
  if (!xml.trim()) return [];
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  const output: NewsItem[] = [];
  for (const chunk of items) {
    const title = decodeXml(extractTag(chunk, "title") || "").trim();
    const link = decodeXml(extractTag(chunk, "link") || "").trim();
    const pubDate = decodeXml(extractTag(chunk, "pubDate") || "").trim();
    const description = decodeXml(extractTag(chunk, "description") || "").trim();
    if (!title || !link) continue;
    output.push({
      title: title.replace(/\s*-\s*[^-]{1,40}$/, "").trim(),
      link,
      pubDate,
      source,
      description
    });
  }
  return output;
}

async function searchDuck(query: string): Promise<string | null> {
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");

  const raw = await runCurl(url.toString()).catch((error) => {
    log("error", "web.search.curl_error", { error: String(error), query });
    return "";
  });
  if (!raw.trim()) return null;
  let data: DuckResponse;
  try {
    data = JSON.parse(raw) as DuckResponse;
  } catch (error) {
    log("error", "web.search.parse_error", { error: String(error) });
    return null;
  }
  const lines: string[] = [];

  if (data.Heading && data.AbstractText) {
    lines.push(`${data.Heading}: ${data.AbstractText}`);
  }

  const related = flattenTopics(data.RelatedTopics || []).filter((x) => x.Text && x.FirstURL).slice(0, 5);
  if (related.length > 0) {
    lines.push("相关结果:");
    for (const item of related) {
      lines.push(`- ${item.Text}`);
    }
  }

  if (lines.length === 0) return null;
  return lines.join("\n");
}

async function searchWeather(query: string): Promise<string> {
  const city = extractLocation(query);
  const results: string[] = [];

  const wttr = await searchWeatherByWttr(city);
  if (wttr) results.push(wttr);

  const openMeteo = await searchWeatherByOpenMeteo(city);
  if (openMeteo) results.push(openMeteo);

  if (results.length > 0) {
    const confidence = results.length >= 2 ? "高" : "中";
    return formatStructuredResult({
      title: `天气检索（${city}）`,
      overview: "已查询天气专用数据源并完成汇总。",
      points: results.flatMap((x) => x.split("\n")).filter(Boolean),
      confidence
    });
  }

  const fallback = await searchGeneral(`${city} 今日 实时 天气`);
  return formatStructuredResult({
    title: `天气检索（${city}）`,
    overview: "天气专用数据源未命中，已自动切换到通用联网检索。",
    points: [fallback],
    confidence: "低"
  });
}

async function searchWeatherByWttr(city: string): Promise<string | null> {
  const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
  const raw = await runCurl(url).catch((error) => {
    log("warn", "weather.wttr.fetch_failed", { city, error: String(error) });
    return "";
  });
  if (!raw.trim()) return null;

  let data: any;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    log("warn", "weather.wttr.parse_failed", { city, error: String(error) });
    return null;
  }

  const current = data?.current_condition?.[0];
  const today = data?.weather?.[0];
  if (!current) return null;
  const desc = current?.weatherDesc?.[0]?.value || "未知";
  const temp = current?.temp_C ?? "--";
  const feels = current?.FeelsLikeC ?? "--";
  const humidity = current?.humidity ?? "--";
  const wind = current?.windspeedKmph ?? "--";
  const max = today?.maxtempC ?? "--";
  const min = today?.mintempC ?? "--";

  return [
    `天气（wttr）| ${city}`,
    `当前: ${desc}, ${temp}°C, 体感 ${feels}°C`,
    `湿度: ${humidity}% | 风速: ${wind} km/h`,
    `今日: ${min}°C ~ ${max}°C`
  ].join("\n");
}

async function searchWeatherByOpenMeteo(city: string): Promise<string | null> {
  const geoUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
  geoUrl.searchParams.set("name", city);
  geoUrl.searchParams.set("count", "1");
  geoUrl.searchParams.set("language", "zh");
  geoUrl.searchParams.set("format", "json");
  const geoRaw = await runCurl(geoUrl.toString()).catch((error) => {
    log("warn", "weather.open_meteo.geocode_failed", { city, error: String(error) });
    return "";
  });
  if (!geoRaw.trim()) return null;

  let geo: any;
  try {
    geo = JSON.parse(geoRaw);
  } catch (error) {
    log("warn", "weather.open_meteo.geocode_parse_failed", { city, error: String(error) });
    return null;
  }
  const loc = geo?.results?.[0];
  if (!loc?.latitude || !loc?.longitude) return null;

  const weatherUrl = new URL("https://api.open-meteo.com/v1/forecast");
  weatherUrl.searchParams.set("latitude", String(loc.latitude));
  weatherUrl.searchParams.set("longitude", String(loc.longitude));
  weatherUrl.searchParams.set(
    "current",
    "temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code"
  );
  weatherUrl.searchParams.set(
    "daily",
    "temperature_2m_max,temperature_2m_min,precipitation_probability_max"
  );
  weatherUrl.searchParams.set("forecast_days", "1");
  weatherUrl.searchParams.set("timezone", "auto");

  const weatherRaw = await runCurl(weatherUrl.toString()).catch((error) => {
    log("warn", "weather.open_meteo.forecast_failed", { city, error: String(error) });
    return "";
  });
  if (!weatherRaw.trim()) return null;

  let wx: any;
  try {
    wx = JSON.parse(weatherRaw);
  } catch (error) {
    log("warn", "weather.open_meteo.forecast_parse_failed", { city, error: String(error) });
    return null;
  }

  const c = wx?.current;
  const d = wx?.daily;
  if (!c) return null;
  const desc = weatherCodeToZh(c.weather_code);
  const rain = d?.precipitation_probability_max?.[0] ?? "--";
  const min = d?.temperature_2m_min?.[0] ?? "--";
  const max = d?.temperature_2m_max?.[0] ?? "--";
  const humidity = c?.relative_humidity_2m ?? "--";
  const wind = c?.wind_speed_10m ?? "--";

  return [
    `天气（Open‑Meteo）| ${loc.name || city}`,
    `当前: ${desc}, ${c.temperature_2m}°C`,
    `湿度: ${humidity}% | 风速: ${wind} km/h`,
    `今日: ${min}°C ~ ${max}°C | 降水概率: ${rain}%`
  ].join("\n");
}

function isWeatherQuery(query: string): boolean {
  const q = query.toLowerCase();
  return q.includes("天气") || q.includes("weather") || q.includes("气温");
}

function extractLocation(query: string): string {
  const normalized = query
    .replace(/[?？!！]/g, " ")
    .replace(/今天|今日|明天|后天|实时|最新|现在|天气|气温|查询|一下|帮我|请|的/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "北京";
  const parts = normalized.split(" ").filter(Boolean);
  return parts[0] || "北京";
}

function buildGeneralCandidates(query: string): string[] {
  const base = normalizeSearchPhrase(query);

  // 检测是否是企业/人物查询
  const isCompanyQuery = /公司|科技|集团|企业|创始人|CEO|总裁|董事|合伙人/.test(query);
  const isPersonQuery = /简历|人物|高管|履历/.test(query);

  if (isCompanyQuery || isPersonQuery) {
    // 对企业/人物查询，使用更精准的关键词
    const list = [
      base,
      `${base} 简介`,
      `${base} 百科`,
      `${base} 官网`,
      `${base} 介绍`
    ];
    return Array.from(new Set(list.map((x) => x.trim()).filter(Boolean))).slice(0, 5);
  }

  const list = [base, `${base} 最新`, `${base} 官方`, `${base} 新闻`];
  return Array.from(new Set(list.map((x) => x.trim()).filter(Boolean))).slice(0, 4);
}

function buildNewsCandidates(query: string): string[] {
  const base = normalizeSearchPhrase(query);
  const list = [
    `${base} 新闻`,
    `${base} 最新`,
    `${base} 采访`,
    `${base} 融资`
  ];
  return Array.from(new Set(list.map((x) => x.trim()).filter(Boolean))).slice(0, 4);
}

function normalizeSearchPhrase(query: string): string {
  return query
    .replace(/联网查询|公开的|公开信息|新闻信息|帮我|请|一下|查询|搜索/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isNewsQuery(query: string): boolean {
  return /新闻|简历|公开信息|采访|融资|最近|近况/.test(query);
}

function weatherCodeToZh(code: number): string {
  const map: Record<number, string> = {
    0: "晴",
    1: "基本晴",
    2: "局部多云",
    3: "阴",
    45: "雾",
    48: "冻雾",
    51: "小毛毛雨",
    53: "毛毛雨",
    55: "强毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    80: "阵雨",
    81: "阵雨",
    82: "强阵雨",
    95: "雷暴"
  };
  return map[code] || `天气码${code}`;
}

function runCurl(url: string): Promise<string> {
  // P1-9修复: 验证 URL，防止 SSRF 攻击
  if (!validateUrl(url)) {
    return Promise.reject(new Error(`Invalid or unsafe URL: ${url}`));
  }

  // 使用代理配置（如果有）
  const proxyUrl = process.env.DISCORD_PROXY_URL || process.env.https_proxy || process.env.http_proxy;
  const proxyArg = proxyUrl ? `-x ${shellEscape(proxyUrl)}` : '';
  const cmd = `curl -sL ${proxyArg} --max-time 20 --retry 2 --retry-delay 1 ${shellEscape(url)}`;

  return new Promise((resolve, reject) => {
    exec(
      cmd,
      {
        timeout: 25_000,
        maxBuffer: 2 * 1024 * 1024,
        env: process.env,
        shell: "/bin/zsh"
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${stderr || stdout}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function flattenTopics(
  topics: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>
): Array<{ Text?: string; FirstURL?: string }> {
  const output: Array<{ Text?: string; FirstURL?: string }> = [];
  for (const topic of topics) {
    if (topic.Topics && topic.Topics.length > 0) {
      output.push(...topic.Topics);
      continue;
    }
    output.push(topic);
  }
  return output;
}

function extractTag(xmlChunk: string, tag: string): string | null {
  const match = xmlChunk.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1] || null;
}

function decodeXml(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function dedupeNews(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const item of items) {
    const key = `${item.title}::${item.link}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function buildNewsOverview(items: NewsItem[]): string[] {
  const top = items.slice(0, 5);
  const dates = top
    .map((x) => (x.pubDate ? Date.parse(x.pubDate) : NaN))
    .filter((x) => Number.isFinite(x)) as number[];
  const latest = dates.length > 0 ? new Date(Math.max(...dates)).toISOString().slice(0, 10) : "未知";

  const ipoCount = top.filter((x) => /ipo|上市|港交所|备案|估值/i.test(x.title)).length;
  const interviewCount = top.filter((x) => /专访|访谈|对话|演讲/i.test(x.title)).length;
  const personHit = top.filter((x) => /姜平/i.test(`${x.title}\n${x.description || ""}`)).length;

  const lines: string[] = [];
  lines.push(`最近可见时间点：${latest}。`);
  lines.push(
    `主题分布：资本市场动态 ${ipoCount} 条，人物观点/访谈 ${interviewCount} 条。`
  );
  lines.push(
    personHit > 0
      ? `人物相关性：已命中 ${personHit} 条含“姜平”直接提及的内容。`
      : "人物相关性：直接提及“姜平”的内容较少，部分结果仍为公司层面新闻。"
  );
  return lines;
}

function rankNewsByTargets(items: NewsItem[], targetPeople: string[]): NewsItem[] {
  if (targetPeople.length === 0) return items;
  const scored = items.map((item) => {
    const text = `${item.title}\n${item.description || ""}`.toLowerCase();
    let score = 0;
    for (const name of targetPeople) {
      const lower = name.toLowerCase();
      if (item.title.toLowerCase().includes(lower)) score += 5;
      if (text.includes(lower)) score += 2;
    }
    if (/创始人|董事长|总裁|ceo|专访|访谈/.test(item.title)) score += 1;
    return { item, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const strong = scored.filter((x) => x.score >= 2).map((x) => x.item);
  if (strong.length >= 3) return strong;
  return scored.map((x) => x.item);
}

function extractPersonTargets(query: string): string[] {
  const targets: string[] = [];
  if (query.includes("姜平")) targets.push("姜平");
  if (query.includes("吴明辉")) targets.push("吴明辉");
  return targets;
}

function toShortDate(input: string): string {
  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) return input;
  return new Date(ms).toISOString().slice(0, 10);
}

function scoreNewsQuality(
  items: NewsItem[],
  targetPeople: string[]
): { score: number; level: "高" | "中" | "低"; confidence: "高" | "中" | "低" } {
  const top = items.slice(0, 6);
  const sourceSet = new Set(top.map((x) => x.source));
  const targetHits = top.filter((x) => {
    if (targetPeople.length === 0) return false;
    const text = `${x.title}\n${x.description || ""}`.toLowerCase();
    return targetPeople.some((p) => text.includes(p.toLowerCase()));
  }).length;

  let recencyScore = 0;
  const now = Date.now();
  const dates = top
    .map((x) => (x.pubDate ? Date.parse(x.pubDate) : NaN))
    .filter((x) => Number.isFinite(x)) as number[];
  if (dates.length > 0) {
    const latest = Math.max(...dates);
    const days = Math.max(0, Math.floor((now - latest) / (24 * 3600 * 1000)));
    if (days <= 3) recencyScore = 40;
    else if (days <= 10) recencyScore = 28;
    else if (days <= 30) recencyScore = 16;
    else recencyScore = 8;
  }

  const diversityScore = Math.min(30, sourceSet.size * 12);
  const hitScore = targetPeople.length > 0 ? Math.min(30, targetHits * 10) : 18;
  const score = Math.max(0, Math.min(100, recencyScore + diversityScore + hitScore));

  if (score >= 75) return { score, level: "高", confidence: "高" };
  if (score >= 50) return { score, level: "中", confidence: "中" };
  return { score, level: "低", confidence: "低" };
}

function formatStructuredResult(input: {
  title: string;
  overview: string;
  points: string[];
  confidence: "高" | "中" | "低" | "中-高";
}): string {
  const points = input.points
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((x) => (x.startsWith("- ") ? x : `- ${x}`));
  return [input.title, "摘要概述：", `- ${input.overview}`, "关键要点：", ...points, `置信度：${input.confidence}`].join(
    "\n"
  );
}
