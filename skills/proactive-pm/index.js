/**
 * Proactive PM（主动产品经理）Skill
 *
 * 每日以产品经理视角扫描全球产品生态，
 * 聚焦三大方向：AI（LLM/Agent）、Robot（具身智能/人形/机器狗）、IM（AI时代新形态），
 * 识别 TPF（技术产品适配）机遇、新产品形态、用户洞察，
 * 生成产品 Idea，推送到 Discord / Telegram。
 */

import fs from "node:fs";
import path from "node:path";
import {
  runCurl, todayString, ensureDir,
  callAnthropic, sendToDiscord, sendToTelegram, parseRssItems, BRAIN_DIR,
} from "../_shared/proactive-utils.js";

// ─── 配置 ────────────────────────────────────────────────────────────────────

const DEFAULT_CHANNEL_ID = process.env.DEFAULT_DISCORD_CHANNEL_ID;
const PM_REPORTS_DIR = path.join(BRAIN_DIR, "pm-reports");

const REDDIT_UA_ARGS = ["-H", "User-Agent: JPClaw/1.0 (主动产品经理; github.com/user/jpclaw)"];

// 三大关注域定义（固定，代表姜哥的产品兴趣范围）
const DOMAINS = [
  {
    id: "ai",
    label: "AI产品",
    emoji: "🤖",
    queries: ["AI agent product", "LLM app launch", "AI assistant startup"],
    subreddits: ["artificial", "MachineLearning", "ChatGPT", "LocalLLaMA"],
  },
  {
    id: "robot",
    label: "Robot产品",
    emoji: "🦾",
    queries: ["humanoid robot product", "robot dog launch", "embodied AI startup"],
    subreddits: ["robotics", "artificial", "ScienceUncensored"],
  },
  {
    id: "im",
    label: "IM新形态",
    emoji: "💬",
    queries: ["AI chat app launch", "messaging app AI", "communication startup AI"],
    subreddits: ["SaaS", "startups", "productivity"],
  },
];

// ─── 数据采集 ────────────────────────────────────────────────────────────────

/** ProductHunt 今日热门产品（RSS） */
async function fetchProductHunt() {
  try {
    const raw = await runCurl("https://www.producthunt.com/feed");
    const items = parseRssItems(raw, "ProductHunt");
    return items.slice(0, 20).map((i) => ({
      title: i.title || "",
      link: i.link || "",
      description: (i.description || "").slice(0, 200),
      source: "ProductHunt",
    }));
  } catch { return []; }
}

/** HackerNews Show HN（Algolia API，最近 48h） */
async function fetchHNShowHN() {
  try {
    const cutoff = Math.floor((Date.now() - 48 * 60 * 60 * 1000) / 1000);
    const url = `https://hn.algolia.com/api/v1/search?tags=show_hn&numericFilters=created_at_i>${cutoff}&hitsPerPage=20`;
    const raw = await runCurl(url);
    const data = JSON.parse(raw);
    return (data.hits || []).map((h) => ({
      title: h.title || "",
      link: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      points: h.points || 0,
      comments: h.num_comments || 0,
      source: "HackerNews ShowHN",
    }));
  } catch { return []; }
}

/** HackerNews Launch HN（最近 48h） */
async function fetchHNLaunchHN() {
  try {
    const cutoff = Math.floor((Date.now() - 48 * 60 * 60 * 1000) / 1000);
    const url = `https://hn.algolia.com/api/v1/search?query=Launch+HN&tags=story&numericFilters=created_at_i>${cutoff}&hitsPerPage=15`;
    const raw = await runCurl(url);
    const data = JSON.parse(raw);
    return (data.hits || [])
      .filter((h) => /launch\s+hn/i.test(h.title || ""))
      .map((h) => ({
        title: h.title || "",
        link: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        points: h.points || 0,
        comments: h.num_comments || 0,
        source: "HackerNews LaunchHN",
      }));
  } catch { return []; }
}

/** Google News / Bing News 按查询词采集 */
async function fetchNews(query) {
  const results = [];
  try {
    const gUrl = new URL("https://news.google.com/rss/search");
    gUrl.searchParams.set("q", query);
    gUrl.searchParams.set("hl", "en-US");
    gUrl.searchParams.set("gl", "US");
    gUrl.searchParams.set("ceid", "US:en");
    const raw = await runCurl(gUrl.toString());
    results.push(...parseRssItems(raw, "GoogleNews").slice(0, 8));
  } catch {}
  try {
    const bUrl = new URL("https://www.bing.com/news/search");
    bUrl.searchParams.set("q", query);
    bUrl.searchParams.set("format", "rss");
    const raw = await runCurl(bUrl.toString());
    results.push(...parseRssItems(raw, "BingNews").slice(0, 5));
  } catch {}
  // 去重
  const seen = new Set();
  return results.filter((i) => { if (seen.has(i.title)) return false; seen.add(i.title); return true; });
}

/** Reddit 多版块采集（合并指定 subreddit 的热门帖） */
async function fetchRedditSubreddits(subreddits) {
  const results = [];
  for (const sub of subreddits) {
    try {
      const url = `https://www.reddit.com/r/${sub}/hot.json?limit=15&t=day`;
      const raw = await runCurl(url, REDDIT_UA_ARGS);
      const data = JSON.parse(raw);
      if (!data?.data?.children) continue;
      const posts = data.data.children
        .map((c) => c.data)
        .filter((p) => (p.score || 0) >= 50)
        .map((p) => ({
          title: p.title || "",
          link: `https://www.reddit.com${p.permalink}`,
          subreddit: p.subreddit || sub,
          score: p.score || 0,
          comments: p.num_comments || 0,
          selftext: (p.selftext || "").slice(0, 200),
          source: `Reddit r/${sub}`,
        }));
      results.push(...posts);
    } catch {}
  }
  return results;
}

// ─── 数据汇集（按域） ────────────────────────────────────────────────────────

async function gatherDomainData(domain) {
  // 并行采集该域的所有新闻查询
  const newsResults = await Promise.allSettled(domain.queries.map((q) => fetchNews(q)));
  const news = newsResults
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => r.value)
    .slice(0, 12);

  const reddit = await fetchRedditSubreddits(domain.subreddits);

  return { news, reddit };
}

// ─── AI 分析：以产品经理视角生成报告 ────────────────────────────────────────

async function generateReport({ date, phItems, hnShows, hnLaunches, domainData }) {
  const systemPrompt = `你是姜哥的「主动产品经理」，技术出身，擅长将新技术转化为产品机遇。

## 你的核心职责
1. **识别新产品形态**：哪些产品形态是以前不存在、现在技术才刚刚允许的？
2. **评估 TPF（技术产品适配）**：技术成熟度 × 用户痛点强度 × 市场窗口，打出 A/B/C 评级
3. **提炼用户洞察**：用户真正想要什么？现有产品哪里没满足？
4. **生成可执行产品 Idea**：具体到「谁用、用来干什么、为什么现在是时候」

## 三大关注域
- **AI产品**（LLM、Agent、多模态工具）
- **Robot产品**（具身智能、人形机器人、机器狗周边产品）
- **IM新形态**（AI 时代即时通讯的新范式：异步 AI 代理、情境感知消息、持久 AI 人格等）

## 输出格式（Discord Markdown）

🎯 **主动产品经理** | ${date}

🤖 **AI产品**
📦 新产品形态：[本周出现了哪些新类别]
💡 TPF机遇：[技术 + 用户痛点 + 评级，如「多模态 Agent 做工作流自动化 [A-]」]
🔥 用户洞察：[用户在抱怨什么？在追什么？]

🦾 **Robot产品**
📦 新产品形态：...
💡 TPF机遇：...
🔥 用户洞察：...

💬 **IM新形态**
📦 新产品形态：...
💡 TPF机遇：...
🔥 用户洞察：...

💡 **今日产品 Idea**（最多3条，必须具体可落地）
• [Idea 1]（TPF: A）— 谁用 / 做什么 / 为什么现在
• [Idea 2]（TPF: B+）— ...
• [Idea 3]（TPF: B）— ...

📌 **一句话洞察**
[今天最重要的产品信号，一句话总结]

---
JPClaw 主动产品经理 · ${date}

## 注意
- 中文为主，技术术语可用英文
- 只给出来自原始数据的链接，不编造
- 聚焦「产品 vs 技术」视角，不要写成技术博客
- 如果某个域今天没有明显信号，直接写「今日无显著信号」，不要凑数`;

  const contextParts = [];

  if (phItems.length > 0) {
    contextParts.push(
      "【ProductHunt 今日上新】\n" +
      phItems.slice(0, 15).map((i, n) => `${n + 1}. ${i.title}\n   ${i.description}\n   ${i.link}`).join("\n")
    );
  }

  if (hnShows.length > 0 || hnLaunches.length > 0) {
    const all = [...hnShows, ...hnLaunches].sort((a, b) => (b.points || 0) - (a.points || 0)).slice(0, 15);
    contextParts.push(
      "【HackerNews 新产品发布】\n" +
      all.map((i, n) => `${n + 1}. [${i.points}pts/${i.comments}c] ${i.title}\n   ${i.link}`).join("\n")
    );
  }

  for (const { domain, data } of domainData) {
    const parts = [];
    if (data.news.length > 0) {
      parts.push(
        `【${domain.label} 新闻】\n` +
        data.news.slice(0, 10).map((i, n) => `${n + 1}. ${i.title} (${i.source})`).join("\n")
      );
    }
    if (data.reddit.length > 0) {
      parts.push(
        `【${domain.label} 社区热议】\n` +
        data.reddit.slice(0, 8).map((i, n) => `${n + 1}. [↑${i.score}] ${i.title}\n   r/${i.subreddit} ${i.selftext ? "— " + i.selftext : ""}`).join("\n")
      );
    }
    if (parts.length > 0) contextParts.push(parts.join("\n\n"));
  }

  if (contextParts.length === 0) {
    return `🎯 **主动产品经理** | ${date}\n\n暂无数据可用。\n\n---\nJPClaw 主动产品经理 · ${date}`;
  }

  return callAnthropic(systemPrompt, contextParts.join("\n\n---\n\n"), { maxTokens: 3000 });
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

export async function run(input) {
  try {
    let params = {};
    try { params = typeof input === "string" ? JSON.parse(input) : input || {}; } catch { params = {}; }

    const channelId = params.channelId || DEFAULT_CHANNEL_ID;
    const telegramChatId = params.telegramChatId || process.env.DEFAULT_TELEGRAM_CHAT_ID;
    const date = todayString();

    // ① 并行采集全局 + 各域数据
    const [phResult, hnShowResult, hnLaunchResult, ...domainResults] = await Promise.allSettled([
      fetchProductHunt(),
      fetchHNShowHN(),
      fetchHNLaunchHN(),
      ...DOMAINS.map((d) => gatherDomainData(d)),
    ]);

    const phItems = phResult.status === "fulfilled" ? phResult.value : [];
    const hnShows = hnShowResult.status === "fulfilled" ? hnShowResult.value : [];
    const hnLaunches = hnLaunchResult.status === "fulfilled" ? hnLaunchResult.value : [];
    const domainData = DOMAINS.map((domain, idx) => ({
      domain,
      data: domainResults[idx].status === "fulfilled" ? domainResults[idx].value : { news: [], reddit: [] },
    }));

    const stats = {
      producthunt: phItems.length,
      hn: hnShows.length + hnLaunches.length,
      domains: Object.fromEntries(domainData.map(({ domain, data }) => [
        domain.id,
        { news: data.news.length, reddit: data.reddit.length },
      ])),
    };

    // ② AI 生成报告
    const reportContent = await generateReport({ date, phItems, hnShows, hnLaunches, domainData });

    // ③ 持久化
    ensureDir(PM_REPORTS_DIR);
    const reportPath = path.join(PM_REPORTS_DIR, `${date}-pm.md`);
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
      ok: true, reportDate: date, stats, reportPath, discordMessageIds, telegramMessageIds,
      message: `主动产品经理报告已生成，ProductHunt ${phItems.length} 条，HN ${hnShows.length + hnLaunches.length} 条`,
    }, null, 2);
  } catch (error) {
    return JSON.stringify({ ok: false, error: error.message }, null, 2);
  }
}

export default run;
