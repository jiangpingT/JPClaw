/**
 * Community Radar (社区雷达) Skill
 *
 * 扫描 Reddit、HackerNews 近 N 天社区讨论，
 * 获取工具和话题的真实用户反馈，
 * 通过 AI 做情感分析和趋势识别，推送报告到 Discord。
 */

import fs from "node:fs";
import path from "node:path";
import {
  runCurl, todayString, ensureDir,
  callAnthropic, sendToDiscord, sendToTelegram, BRAIN_DIR,
} from "../_shared/proactive-utils.js";

// ─── 配置 ────────────────────────────────────────────────────────────────────

const DEFAULT_KEYWORDS = ["LLM", "Claude", "AI", "TypeScript"];
const DEFAULT_SOURCES = ["reddit", "hackernews"];
const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_MIN_ENGAGEMENT = 10;
const DEFAULT_CHANNEL_ID = "1469204772379693222";
const RADAR_DIR = path.join(BRAIN_DIR, "radar");

// Reddit 要求设置 User-Agent，否则返回 429
const REDDIT_UA_ARGS = ["-H", "User-Agent: JPClaw/1.0 (社区雷达; github.com/user/jpclaw)"];

// ─── 数据采集：Reddit ────────────────────────────────────────────────────────

async function fetchRedditSearch(keyword, lookbackDays) {
  try {
    const timeFilter = lookbackDays <= 7 ? "week" : "month";
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(keyword)}&sort=relevance&t=${timeFilter}&limit=25`;
    const raw = await runCurl(url, REDDIT_UA_ARGS);
    const data = JSON.parse(raw);

    if (!data?.data?.children) return [];

    return data.data.children
      .map((child) => {
        const post = child.data;
        return {
          title: post.title || "",
          link: `https://www.reddit.com${post.permalink}`,
          subreddit: post.subreddit || "",
          score: post.score || 0,
          comments: post.num_comments || 0,
          author: post.author || "",
          created: new Date((post.created_utc || 0) * 1000).toISOString(),
          selftext: (post.selftext || "").slice(0, 300),
          source: "Reddit",
        };
      })
      .filter((p) => p.title);
  } catch {
    return [];
  }
}

async function fetchRedditSubreddit(subreddit, lookbackDays) {
  try {
    const timeFilter = lookbackDays <= 7 ? "week" : "month";
    const url = `https://www.reddit.com/r/${subreddit}/top.json?t=${timeFilter}&limit=15`;
    const raw = await runCurl(url, REDDIT_UA_ARGS);
    const data = JSON.parse(raw);

    if (!data?.data?.children) return [];

    return data.data.children
      .map((child) => {
        const post = child.data;
        return {
          title: post.title || "",
          link: `https://www.reddit.com${post.permalink}`,
          subreddit: post.subreddit || "",
          score: post.score || 0,
          comments: post.num_comments || 0,
          author: post.author || "",
          created: new Date((post.created_utc || 0) * 1000).toISOString(),
          selftext: (post.selftext || "").slice(0, 300),
          source: "Reddit",
        };
      })
      .filter((p) => p.title);
  } catch {
    return [];
  }
}

// ─── 数据采集：HackerNews ────────────────────────────────────────────────────

async function fetchHNSearch(keyword, lookbackDays) {
  try {
    const cutoffSeconds = Math.floor(
      (Date.now() - lookbackDays * 24 * 60 * 60 * 1000) / 1000
    );
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(keyword)}&tags=story&numericFilters=created_at_i%3E${cutoffSeconds}&hitsPerPage=20`;
    const raw = await runCurl(url);
    const data = JSON.parse(raw);

    return (data.hits || []).map((hit) => ({
      title: hit.title || "",
      link: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      hnLink: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      score: hit.points || 0,
      comments: hit.num_comments || 0,
      author: hit.author || "",
      created: hit.created_at || "",
      source: "HackerNews",
    }));
  } catch {
    return [];
  }
}

// ─── 数据汇总 ────────────────────────────────────────────────────────────────

async function collectData(keywords, sources, minEngagement, lookbackDays) {
  const allPosts = [];
  const fetchPromises = [];

  for (const keyword of keywords) {
    if (sources.includes("reddit")) {
      fetchPromises.push(fetchRedditSearch(keyword, lookbackDays));
    }
    if (sources.includes("hackernews")) {
      fetchPromises.push(fetchHNSearch(keyword, lookbackDays));
    }
  }

  // 额外采集相关 subreddit
  if (sources.includes("reddit")) {
    const relatedSubreddits = ["MachineLearning", "LocalLLaMA", "typescript", "node"];
    for (const sub of relatedSubreddits) {
      fetchPromises.push(fetchRedditSubreddit(sub, lookbackDays));
    }
  }

  const results = await Promise.allSettled(fetchPromises);

  for (const result of results) {
    if (result.status === "fulfilled") {
      allPosts.push(...result.value);
    }
  }

  // 去重（按标题）
  const seen = new Set();
  const deduped = allPosts.filter((post) => {
    if (seen.has(post.title)) return false;
    seen.add(post.title);
    return true;
  });

  // 过滤低互动帖子
  const filtered = deduped.filter(
    (post) => (post.score + post.comments) >= minEngagement
  );

  // 按互动量排序
  filtered.sort((a, b) => (b.score + b.comments) - (a.score + a.comments));

  return filtered;
}

// ─── AI 分析 ─────────────────────────────────────────────────────────────────

async function analyzeWithAI(posts, keywords, lookbackDays) {
  const systemPrompt = `你是「阿策」的社区雷达模块，负责分析社区讨论并提取有价值的洞察。

## 你的任务

分析提供的 Reddit 和 HackerNews 帖子数据，生成一份社区雷达报告。

## 报告格式（纯文本，适配 Discord）

📡 **社区雷达** | ${todayString()} | 近${lookbackDays}天
关键词：${keywords.join("、")}

🔥 **社区热点 TOP 5**
按热度排列，每条附带情感标记（✅正面 / ❌负面 / ➖中立）

📊 **情感分布**
正面 / 负面 / 中立 的大致比例

⚠️ **常见痛点 TOP 3**
社区反复提到的问题

🚀 **值得关注**
新兴项目、工具或趋势

💬 **精选讨论**
2-3 条最有价值的讨论（标题 + 链接 + 一句话总结）

📈 **趋势判断**
基于数据的 1-2 条趋势判断

---
JPClaw 社区雷达 · 自动生成

## 重要原则

- 聚焦「用户真实反馈」，不是官方营销
- 情感判断要基于实际内容，不要臆测
- 链接必须来自原始数据
- 中文为主，技术术语可用英文
- 报告总长度控制在 1800 字符内`;

  // 构建帖子数据
  const postsText = posts
    .slice(0, 40)
    .map(
      (post, i) =>
        `${i + 1}. [${post.source}${post.subreddit ? `/r/${post.subreddit}` : ""}] ${post.title}\n   ⬆️${post.score} 💬${post.comments}\n   ${post.link}\n   ${post.selftext ? `摘要: ${post.selftext.slice(0, 150)}` : ""}`
    )
    .join("\n\n");

  if (!postsText.trim()) {
    return `📡 **社区雷达** | ${todayString()}\n\n暂无相关社区讨论数据。\n\n---\nJPClaw 社区雷达 · 自动生成`;
  }

  return callAnthropic(
    systemPrompt,
    `以下是近 ${lookbackDays} 天社区讨论数据（共 ${posts.length} 条，展示前 ${Math.min(posts.length, 40)} 条）：\n\n${postsText}`,
    { maxTokens: 2048 }
  );
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

export async function run(input) {
  try {
    let params = {};
    try { params = typeof input === "string" ? JSON.parse(input) : input || {}; } catch { params = {}; }

    const keywords = params.keywords || DEFAULT_KEYWORDS;
    const sources = params.sources || DEFAULT_SOURCES;
    const lookbackDays = params.lookbackDays || DEFAULT_LOOKBACK_DAYS;
    const minEngagement = params.minEngagement || DEFAULT_MIN_ENGAGEMENT;
    const channelId = params.channelId || DEFAULT_CHANNEL_ID;
    const telegramChatId = params.telegramChatId;
    const date = todayString();

    // ① 多源采集（传入 lookbackDays）
    const posts = await collectData(keywords, sources, minEngagement, lookbackDays);

    const sourceStats = {
      reddit: posts.filter((p) => p.source === "Reddit").length,
      hackernews: posts.filter((p) => p.source === "HackerNews").length,
      total: posts.length,
    };

    // ② AI 分析
    const reportContent = await analyzeWithAI(posts, keywords, lookbackDays);

    // ③ 持久化
    ensureDir(RADAR_DIR);
    const reportPath = path.join(RADAR_DIR, `${date}-radar.md`);
    fs.writeFileSync(reportPath, reportContent, "utf-8");

    // ④ Discord 推送
    let discordMessageIds = [];
    try { discordMessageIds = await sendToDiscord(channelId, reportContent); }
    catch (e) { discordMessageIds = [`error: ${e.message}`]; }

    // ⑤ Telegram 推送
    let telegramMessageIds = [];
    if (telegramChatId) {
      try { telegramMessageIds = await sendToTelegram(telegramChatId, reportContent); }
      catch (e) { telegramMessageIds = [`error: ${e.message}`]; }
    }

    return JSON.stringify({
      ok: true, radarDate: date, period: `last ${lookbackDays} days`,
      keywords, sources: sourceStats, reportPath, discordMessageIds, telegramMessageIds,
      message: `社区雷达已生成，共分析 ${posts.length} 条讨论，报告已推送到 Discord`,
    }, null, 2);
  } catch (error) {
    return JSON.stringify({ ok: false, error: error.message }, null, 2);
  }
}

export default run;
