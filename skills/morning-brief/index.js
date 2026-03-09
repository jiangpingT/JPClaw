/**
 * Morning Brief (晨间简报) Skill
 *
 * 从天气、新闻、待办任务等数据源收集信息，
 * 通过 AI 组装结构化简报并推送到 Discord 频道。
 */

import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HttpsProxyAgent } from "https-proxy-agent";
import { sendToTelegram, sendToDmwork } from "../_shared/proactive-utils.js";

// ─── 配置 ────────────────────────────────────────────────────────────────────

const DEFAULT_CITY = "北京";
const HOME_CITY = "北京";   // 用于判断是否在家，影响天气播报逻辑
const DEFAULT_CHANNEL_ID = process.env.DEFAULT_DISCORD_CHANNEL_ID;
const DEFAULT_NEWS_TOPICS = ["AI", "科技", "创业"];
const DISCORD_MSG_LIMIT = 2000;
const CURL_TIMEOUT_MS = 20_000;
const TASKS_FILE = path.resolve(process.cwd(), "sessions", "schedules", "tasks.json");
const WEATHER_CACHE_DIR = path.resolve(process.cwd(), "sessions", "brain", "weather");

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function shellEscape(value) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function runCurl(url) {
  const proxyUrl =
    process.env.DISCORD_PROXY_URL ||
    process.env.https_proxy ||
    process.env.http_proxy;
  const proxyArg = proxyUrl ? `-x ${shellEscape(proxyUrl)}` : "";
  const cmd = `curl -sL ${proxyArg} --max-time 20 --retry 2 --retry-delay 1 ${shellEscape(url)}`;

  return new Promise((resolve, reject) => {
    exec(
      cmd,
      {
        timeout: CURL_TIMEOUT_MS + 5000,
        maxBuffer: 2 * 1024 * 1024,
        env: process.env,
        shell: "/bin/zsh",
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`curl failed: ${error.message}\n${stderr || stdout}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function getProxyAgent() {
  const proxyUrl =
    process.env.DISCORD_PROXY_URL ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    "http://127.0.0.1:7890";
  if (!proxyUrl) return undefined;
  return new HttpsProxyAgent(proxyUrl);
}

function extractTag(xmlChunk, tag) {
  const match = xmlChunk.match(
    new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "i")
  );
  if (!match) return null;
  // 提取标签内容
  const inner = match[0].replace(
    new RegExp(`^<${tag}>|<\\/${tag}>$`, "gi"),
    ""
  );
  return inner;
}

function decodeXml(input) {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function todayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function weekdayZh() {
  const days = ["日", "一", "二", "三", "四", "五", "六"];
  return `周${days[new Date().getDay()]}`;
}

// ─── 数据获取：天气 ──────────────────────────────────────────────────────────

function weatherCachePath(city, dateStr) {
  return path.join(WEATHER_CACHE_DIR, `${dateStr}-${city}.json`);
}

function loadYesterdayWeather(city) {
  try {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const yesterday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const p = weatherCachePath(city, yesterday);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch { return null; }
}

function saveWeatherCache(city, dateStr, data) {
  try {
    if (!fs.existsSync(WEATHER_CACHE_DIR)) fs.mkdirSync(WEATHER_CACHE_DIR, { recursive: true });
    fs.writeFileSync(weatherCachePath(city, dateStr), JSON.stringify(data), "utf-8");
  } catch { /* 存档失败不影响主流程 */ }
}

async function fetchWeather(city) {
  try {
    const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
    const raw = await runCurl(url);
    if (!raw.trim()) return null;

    const data = JSON.parse(raw);
    const current = data?.current_condition?.[0];
    const today = data?.weather?.[0];
    if (!current) return null;

    // 最大降雨概率（取全天各时段最大值）
    const hourly = today?.hourly ?? [];
    const maxRainChance = Math.max(0, ...hourly.map(h => Number(h.chanceofrain ?? 0)));
    const maxSnowChance = Math.max(0, ...hourly.map(h => Number(h.chanceofsnow ?? 0)));
    const totalPrecipMM = hourly.reduce((s, h) => s + Number(h.precipMM ?? 0), 0);

    // 极端天气判断（大风 / 暴雨雪 / 高温 / 寒潮）
    const windKmph = Number(current.windspeedKmph ?? 0);
    const tempC = Number(today?.mintempC ?? 99);
    const maxTempC = Number(today?.maxtempC ?? -99);
    const extremeFlags = [];
    if (windKmph >= 60) extremeFlags.push(`大风 ${windKmph}km/h`);
    if (maxRainChance >= 70 && totalPrecipMM >= 25) extremeFlags.push("暴雨");
    if (maxSnowChance >= 60) extremeFlags.push("大雪");
    if (tempC <= -10) extremeFlags.push(`寒潮（最低${tempC}°C）`);
    if (maxTempC >= 37) extremeFlags.push(`高温${maxTempC}°C`);

    const result = {
      city,
      desc: current.weatherDesc?.[0]?.value || "未知",
      temp: Number(current.temp_C ?? 0),
      feelsLike: Number(current.FeelsLikeC ?? 0),
      humidity: current.humidity ?? "--",
      windSpeed: windKmph,
      maxTemp: Number(today?.maxtempC ?? 0),
      minTemp: Number(today?.mintempC ?? 0),
      maxRainChance,
      totalPrecipMM: Math.round(totalPrecipMM * 10) / 10,
      extremeFlags,
    };

    // 保存今日缓存供明天对比
    saveWeatherCache(city, todayString(), { maxTemp: result.maxTemp, minTemp: result.minTemp });

    // 读取昨日缓存
    const yesterday = loadYesterdayWeather(city);
    result.yesterdayMaxTemp = yesterday?.maxTemp ?? null;
    result.yesterdayMinTemp = yesterday?.minTemp ?? null;
    result.tempDrop = (yesterday?.minTemp != null)
      ? result.minTemp - yesterday.minTemp   // 负数 = 降温
      : null;

    return result;
  } catch (err) {
    return { city, error: err.message };
  }
}

// ─── 数据获取：新闻 ──────────────────────────────────────────────────────────

function parseRssItems(xml, source) {
  if (!xml.trim()) return [];
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  const output = [];
  for (const chunk of items) {
    const title = decodeXml(extractTag(chunk, "title") || "").trim();
    const link = decodeXml(extractTag(chunk, "link") || "").trim();
    const pubDate = decodeXml(extractTag(chunk, "pubDate") || "").trim();
    if (!title || !link) continue;
    output.push({
      title: title.replace(/\s*-\s*[^-]{1,40}$/, "").trim(),
      link,
      pubDate,
      source,
    });
  }
  return output;
}

async function fetchGoogleNews(query) {
  try {
    const url = new URL("https://news.google.com/rss/search");
    url.searchParams.set("q", query);
    url.searchParams.set("hl", "zh-CN");
    url.searchParams.set("gl", "CN");
    url.searchParams.set("ceid", "CN:zh-Hans");
    const raw = await runCurl(url.toString());
    return parseRssItems(raw, "GoogleNews");
  } catch {
    return [];
  }
}

async function fetchBingNews(query) {
  try {
    const url = new URL("https://www.bing.com/news/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "rss");
    const raw = await runCurl(url.toString());
    return parseRssItems(raw, "BingNews");
  } catch {
    return [];
  }
}

async function fetchNews(topics) {
  const query = topics.join(" ");
  const [google, bing] = await Promise.allSettled([
    fetchGoogleNews(query),
    fetchBingNews(query),
  ]);

  const items = [
    ...(google.status === "fulfilled" ? google.value : []),
    ...(bing.status === "fulfilled" ? bing.value : []),
  ];

  // 去重
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    const key = item.title;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped.slice(0, 10);
}

// ─── 数据获取：待办任务 ──────────────────────────────────────────────────────

function loadActiveTasks() {
  try {
    if (!fs.existsSync(TASKS_FILE)) return [];
    const raw = fs.readFileSync(TASKS_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter((t) => t.status === "active").map((t) => ({
      id: t.id,
      name: t.name,
      schedule: t.schedule,
      nextRunAt: t.nextRunAt,
    }));
  } catch {
    return [];
  }
}

// ─── AI 组装简报 ─────────────────────────────────────────────────────────────

async function generateBrief(weatherData, newsItems, activeTasks) {
  const baseUrl =
    process.env.ANTHROPIC_BASE_URL || "https://vibe.deepminer.ai";
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!authToken) {
    throw new Error("ANTHROPIC_AUTH_TOKEN 未配置");
  }

  const date = todayString();
  const weekday = weekdayZh();

  // 构建数据上下文
  const contextParts = [];

  // 天气部分
  const isHome = !weatherData?.error && weatherData?.city === HOME_CITY;
  if (weatherData && !weatherData.error) {
    const lines = [
      `城市: ${weatherData.city}（${isHome ? "在家" : "出差"}）`,
      `天气: ${weatherData.desc}`,
      `今日温度: ${weatherData.minTemp}°C ~ ${weatherData.maxTemp}°C，体感 ${weatherData.feelsLike}°C`,
      `风速: ${weatherData.windSpeed} km/h，湿度: ${weatherData.humidity}%`,
      `降雨概率: ${weatherData.maxRainChance}%，今日降水: ${weatherData.totalPrecipMM}mm`,
    ];
    if (weatherData.tempDrop !== null) {
      lines.push(`与昨日相比: 最低温${weatherData.tempDrop >= 0 ? "+" : ""}${weatherData.tempDrop}°C（昨日 ${weatherData.yesterdayMinTemp}~${weatherData.yesterdayMaxTemp}°C）`);
    }
    if (weatherData.extremeFlags.length > 0) {
      lines.push(`⚠️ 极端天气: ${weatherData.extremeFlags.join("、")}`);
    }
    contextParts.push(`【天气数据】\n${lines.join("\n")}`);
  } else {
    contextParts.push(
      `【天气数据】\n数据暂不可用${weatherData?.error ? `（${weatherData.error}）` : ""}`
    );
  }

  // 新闻部分
  if (newsItems.length > 0) {
    const newsText = newsItems
      .slice(0, 8)
      .map((item, i) => `${i + 1}. ${item.title}`)
      .join("\n");
    contextParts.push(`【新闻数据】\n${newsText}`);
  } else {
    contextParts.push("【新闻数据】\n暂无新闻数据");
  }

  // 待办部分
  if (activeTasks.length > 0) {
    const tasksText = activeTasks
      .map((t) => `- ${t.name}（${t.schedule}）`)
      .join("\n");
    contextParts.push(`【活跃任务】\n${tasksText}`);
  } else {
    contextParts.push("【活跃任务】\n当前没有活跃的定时任务");
  }

  const systemPrompt = `你是 JPClaw 的晨间简报助手「阿策」。请根据提供的数据生成一份简洁的晨间简报。

## 关于姜哥的个人背景（天气播报时必须考虑）

姜哥默认住在北京，经常出差外地。家里有两个孩子：
- 大宝：2010年出生（现约15岁，上中学）
- 二宝：2018年出生（现约7岁，上小学）

## 天气播报规则

**在北京（在家）时，必须明确回答以下问题：**
1. 今日温度区间，并与昨日对比——如果最低温降幅 ≥ 5°C，必须提醒「明显降温，给孩子加衣」
2. 是否下雨——如果降雨概率 ≥ 40%，明确说「需要给孩子备伞」
3. 是否有极端天气——有则用 ⚠️ 标出
4. 穿衣建议——结合温度和孩子年龄给出具体建议（大宝/二宝分开说如果差异大）

**出差外地时，只需回答：**
1. 是否有极端天气
2. 穿衣建议（简短一句）

## 输出格式

第一行：☀️ 晨间简报 | ${date} ${weekday}
📍 天气（按上述规则，简洁列点，不超过4行）
📰 新闻（最重要3-5条，每条一句话）
📋 今日任务（活跃定时任务数量即可）
💡 阿策提示（1条，基于天气或新闻，实用）
最后一行：---\nJPClaw 晨间简报 · 自动生成

总长度控制在 1500 字符以内，中文，不用 markdown 表格。`;

  const userMessage = `今天是 ${date}（${weekday}）\n\n` + contextParts.join("\n\n");

  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  };

  const agent = getProxyAgent();
  const fetchOptions = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": authToken,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  };
  if (agent) fetchOptions.agent = agent;

  const response = await fetch(`${baseUrl}/v1/messages`, fetchOptions);
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Anthropic API error: ${response.status} ${errText}`);
  }

  const result = await response.json();
  const text =
    result?.content?.[0]?.text || result?.completion || "简报生成失败";
  return text;
}

// ─── Discord 推送 ────────────────────────────────────────────────────────────

async function sendToDiscord(channelId, content) {
  const token =
    process.env.DISCORD_TOKEN || process.env.DISCORD_BOT1_TOKEN;
  if (!token) {
    throw new Error("DISCORD_TOKEN 或 DISCORD_BOT1_TOKEN 未配置");
  }

  const messageIds = [];

  // 按 2000 字符分段发送
  const segments = splitMessage(content, DISCORD_MSG_LIMIT);

  for (const segment of segments) {
    const agent = getProxyAgent();
    const fetchOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${token}`,
      },
      body: JSON.stringify({ content: segment }),
    };
    if (agent) fetchOptions.agent = agent;

    const response = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      fetchOptions
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `Discord API error: ${response.status} ${errText}`
      );
    }

    const data = await response.json();
    if (data.id) messageIds.push(data.id);
  }

  return messageIds;
}

function splitMessage(text, limit) {
  if (text.length <= limit) return [text];

  const segments = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      segments.push(remaining);
      break;
    }

    // 在 limit 范围内找最后一个换行符作为分割点
    let splitIndex = remaining.lastIndexOf("\n", limit);
    if (splitIndex <= 0) {
      // 没有合适的换行符，强制在 limit 处截断
      splitIndex = limit;
    }

    segments.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).replace(/^\n/, "");
  }

  return segments;
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

export async function run(input) {
  try {
    // 解析参数
    let params = {};
    try {
      params = typeof input === "string" ? JSON.parse(input) : input || {};
    } catch {
      params = {};
    }

    const city = params.city || DEFAULT_CITY;
    const channelId = params.channelId || DEFAULT_CHANNEL_ID;
    const telegramChatId = params.telegramChatId || process.env.DEFAULT_TELEGRAM_CHAT_ID;
    const dmworkChannelId = params.dmworkChannelId || process.env.DMWORK_DEFAULT_CHANNEL_ID || "";
    const newsTopics = params.newsTopics || DEFAULT_NEWS_TOPICS;

    // ① 并行获取数据
    const [weatherData, newsItems, activeTasks] = await Promise.all([
      fetchWeather(city),
      fetchNews(newsTopics),
      Promise.resolve(loadActiveTasks()),
    ]);

    const sections = {
      weather: !!(weatherData && !weatherData.error),
      news: newsItems.length > 0,
      tasks: activeTasks.length > 0,
    };

    // ② AI 组装简报
    const briefContent = await generateBrief(
      weatherData,
      newsItems,
      activeTasks
    );

    // ③ 推送到 Discord
    const discordMessageIds = await sendToDiscord(channelId, briefContent);

    // ④ 推送到 Telegram
    let telegramMessageIds = [];
    if (telegramChatId) {
      try { telegramMessageIds = await sendToTelegram(telegramChatId, briefContent); }
      catch (e) { telegramMessageIds = [`error: ${e.message}`]; }
    }

    // ⑤ 推送到 DMWork
    let dmworkStatus = "skipped";
    if (dmworkChannelId) {
      try { await sendToDmwork(dmworkChannelId, briefContent, 2); dmworkStatus = "ok"; }
      catch (e) { dmworkStatus = `error: ${e.message}`; }
    }

    // ⑥ 返回结果
    return JSON.stringify(
      {
        ok: true,
        briefDate: todayString(),
        sections,
        discordMessageIds,
        telegramMessageIds,
        dmworkStatus,
        message: `晨间简报已推送到 Discord 频道 ${channelId}`,
      },
      null,
      2
    );
  } catch (error) {
    return JSON.stringify(
      {
        ok: false,
        error: error.message,
        stack: error.stack,
      },
      null,
      2
    );
  }
}

export default run;
