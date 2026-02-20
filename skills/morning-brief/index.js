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
import { sendToTelegram } from "../_shared/proactive-utils.js";

// ─── 配置 ────────────────────────────────────────────────────────────────────

const DEFAULT_CITY = "北京";
const DEFAULT_CHANNEL_ID = "1469204772379693222";
const DEFAULT_NEWS_TOPICS = ["AI", "科技", "创业"];
const DISCORD_MSG_LIMIT = 2000;
const CURL_TIMEOUT_MS = 20_000;
const TASKS_FILE = path.resolve(process.cwd(), "sessions", "schedules", "tasks.json");

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

async function fetchWeather(city) {
  try {
    const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
    const raw = await runCurl(url);
    if (!raw.trim()) return null;

    const data = JSON.parse(raw);
    const current = data?.current_condition?.[0];
    const today = data?.weather?.[0];
    if (!current) return null;

    return {
      city,
      desc: current.weatherDesc?.[0]?.value || "未知",
      temp: current.temp_C ?? "--",
      feelsLike: current.FeelsLikeC ?? "--",
      humidity: current.humidity ?? "--",
      windSpeed: current.windspeedKmph ?? "--",
      maxTemp: today?.maxtempC ?? "--",
      minTemp: today?.mintempC ?? "--",
    };
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
  if (weatherData && !weatherData.error) {
    contextParts.push(
      `【天气数据】\n城市: ${weatherData.city}\n天气: ${weatherData.desc}\n温度: ${weatherData.temp}°C, 体感 ${weatherData.feelsLike}°C\n湿度: ${weatherData.humidity}%, 风速: ${weatherData.windSpeed} km/h\n今日: ${weatherData.minTemp}°C ~ ${weatherData.maxTemp}°C`
    );
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

格式要求：
- 第一行必须是：☀️ 晨间简报 | ${date} ${weekday}
- 用 📍 标记天气段落
- 用 📰 标记新闻段落（选取最重要的 3-5 条，用简短的一句话描述每条）
- 用 📋 标记待办段落
- 用 💡 标记「阿策的建议」段落（基于天气和新闻给出 1-2 条实用建议）
- 最后一行：---\nJPClaw 晨间简报 · 自动生成

风格要求：
- 中文，简洁有力，不要啰嗦
- 新闻标题保持简短
- 天气用一行描述即可
- 建议要实用、有趣
- 不要使用 markdown 表格
- 总长度控制在 1500 字符以内`;

  const userMessage = contextParts.join("\n\n");

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
    const telegramChatId = params.telegramChatId;
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

    // ⑤ 返回结果
    return JSON.stringify(
      {
        ok: true,
        briefDate: todayString(),
        sections,
        discordMessageIds,
        telegramMessageIds,
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
