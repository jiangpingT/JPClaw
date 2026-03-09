/**
 * Afternoon Report (下午研究报告) Skill
 *
 * 每日基于兴趣主题进行深度研究，
 * 从 HackerNews、GitHub Trending、Google News 采集数据，
 * 由 AI 组织成结构化报告并推送到 Discord。
 */

import fs from "node:fs";
import path from "node:path";
import {
  runCurl, todayString, ensureDir,
  callAnthropic, sendToDiscord, sendToTelegram, sendToDmwork, parseRssItems, BRAIN_DIR,
} from "../_shared/proactive-utils.js";

// ─── 配置 ────────────────────────────────────────────────────────────────────

const DEFAULT_TOPICS = ["AI", "LLM", "TypeScript", "创业"];
const DEFAULT_DEPTH = "standard";
const DEFAULT_CHANNEL_ID = process.env.DEFAULT_DISCORD_CHANNEL_ID;
const REPORTS_DIR = path.join(BRAIN_DIR, "reports");

// ─── 数据采集 ────────────────────────────────────────────────────────────────

async function fetchHackerNews() {
  try {
    const topIdsRaw = await runCurl("https://hacker-news.firebaseio.com/v0/topstories.json");
    const topIds = JSON.parse(topIdsRaw).slice(0, 20);

    const items = await Promise.allSettled(
      topIds.map(async (id) => {
        const raw = await runCurl(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
        const item = JSON.parse(raw);
        return {
          title: item.title || "", link: item.url || `https://news.ycombinator.com/item?id=${id}`,
          score: item.score || 0, comments: item.descendants || 0, source: "HackerNews",
        };
      })
    );

    return items.filter((r) => r.status === "fulfilled").map((r) => r.value).filter((i) => i.title);
  } catch { return []; }
}

async function fetchGitHubTrending() {
  try {
    const url = `https://api.github.com/search/repositories?q=created:>${todayString().slice(0, 7)}-01&sort=stars&order=desc&per_page=15`;
    const raw = await runCurl(url);
    const data = JSON.parse(raw);
    return (data.items || []).map((repo) => ({
      title: `${repo.full_name} - ${repo.description || ""}`.slice(0, 200),
      link: repo.html_url, stars: repo.stargazers_count, language: repo.language, source: "GitHub",
    }));
  } catch { return []; }
}

async function fetchGoogleNews(query) {
  try {
    const url = new URL("https://news.google.com/rss/search");
    url.searchParams.set("q", query); url.searchParams.set("hl", "zh-CN");
    url.searchParams.set("gl", "CN"); url.searchParams.set("ceid", "CN:zh-Hans");
    const raw = await runCurl(url.toString());
    return parseRssItems(raw, "GoogleNews");
  } catch { return []; }
}

async function fetchBingNews(query) {
  try {
    const url = new URL("https://www.bing.com/news/search");
    url.searchParams.set("q", query); url.searchParams.set("format", "rss");
    const raw = await runCurl(url.toString());
    return parseRssItems(raw, "BingNews");
  } catch { return []; }
}

// ─── AI 分析 ─────────────────────────────────────────────────────────────────

async function generateReport(topics, allData, depth) {
  const depthInstruction = {
    quick: "简要概述，每个主题 2-3 个要点。报告控制在 1000 字符内。",
    standard: "适度深入，每个主题 3-5 个要点，附带分析。报告控制在 2000 字符内。",
    deep: "深入分析，每个主题 5-8 个要点，含趋势判断和行动建议。报告控制在 3000 字符内。",
  };

  const systemPrompt = `你是「阿策」的研究助手，负责每日下午为姜哥生成深度研究报告。

## 报告格式（纯文本，适配 Discord）

📚 **下午研究报告** | ${todayString()}
主题：${topics.join("、")}

📰 **关键更新** (What Changed)
💡 **深度分析** (What It Means)
⭐ **值得关注的项目**
🔗 **延伸阅读**（精选链接）
📋 **行动建议**（1-2 条）

---
JPClaw 下午研究报告 · 自动生成

## 深度要求
${depthInstruction[depth] || depthInstruction.standard}

## 重要原则
- 中文为主，技术术语可用英文
- 给出的链接必须来自原始数据，不要编造
- 有洞察性，不要简单罗列`;

  const contextParts = [];
  if (allData.hn?.length > 0) {
    contextParts.push("【HackerNews 热门】\n" + allData.hn.slice(0, 15).map((i, n) => `${n + 1}. ${i.title} (${i.score}pts, ${i.comments}c)\n   ${i.link}`).join("\n"));
  }
  if (allData.github?.length > 0) {
    contextParts.push("【GitHub 热门项目】\n" + allData.github.slice(0, 10).map((i, n) => `${n + 1}. ${i.title} [${i.language || "N/A"}] ⭐${i.stars}\n   ${i.link}`).join("\n"));
  }
  if (allData.news?.length > 0) {
    contextParts.push("【新闻】\n" + allData.news.slice(0, 15).map((i, n) => `${n + 1}. ${i.title} (${i.source})\n   ${i.link}`).join("\n"));
  }

  if (contextParts.length === 0) {
    return `📚 **下午研究报告** | ${todayString()}\n\n暂无数据可用。\n\n---\nJPClaw 下午研究报告 · 自动生成`;
  }

  const maxTokens = depth === "deep" ? 4096 : depth === "quick" ? 1024 : 2048;
  return callAnthropic(systemPrompt, `研究主题：${topics.join("、")}\n\n${contextParts.join("\n\n")}`, { maxTokens });
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

export async function run(input) {
  try {
    let params = {};
    try { params = typeof input === "string" ? JSON.parse(input) : input || {}; } catch { params = {}; }

    const topics = params.topics || DEFAULT_TOPICS;
    const depth = params.depth || DEFAULT_DEPTH;
    const channelId = params.channelId || DEFAULT_CHANNEL_ID;
    const telegramChatId = params.telegramChatId || process.env.DEFAULT_TELEGRAM_CHAT_ID;
    const dmworkChannelId = params.dmworkChannelId || process.env.DMWORK_DEFAULT_CHANNEL_ID || "";
    const dmworkChannelId = params.dmworkChannelId || process.env.DMWORK_DEFAULT_CHANNEL_ID || "";
    const date = todayString();

    // ① 并行多源采集
    const query = topics.join(" ");
    const [hn, github, google, bing] = await Promise.allSettled([
      fetchHackerNews(), fetchGitHubTrending(), fetchGoogleNews(query), fetchBingNews(query),
    ]);

    const allData = {
      hn: hn.status === "fulfilled" ? hn.value : [],
      github: github.status === "fulfilled" ? github.value : [],
      news: [...(google.status === "fulfilled" ? google.value : []), ...(bing.status === "fulfilled" ? bing.value : [])],
    };

    // 去重新闻
    const seen = new Set();
    allData.news = allData.news.filter((i) => { if (seen.has(i.title)) return false; seen.add(i.title); return true; }).slice(0, 15);

    const sections = { hn: allData.hn.length, github: allData.github.length, news: allData.news.length };

    // ② AI 生成报告
    const reportContent = await generateReport(topics, allData, depth);

    // ③ 持久化
    ensureDir(REPORTS_DIR);
    const reportPath = path.join(REPORTS_DIR, `${date}-afternoon.md`);
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

    // ⑥ DMWork 推送
    let dmworkStatus = "skipped";
    if (dmworkChannelId) {
      try { await sendToDmwork(dmworkChannelId, reportContent, 2); dmworkStatus = "ok"; }
      catch (e) { dmworkStatus = `error: ${e.message}`; }
    }

    return JSON.stringify({
      ok: true, reportDate: date, topics, depth, sections, reportPath, discordMessageIds, telegramMessageIds, dmworkStatus,
      message: `下午研究报告已生成并推送到 Discord 频道 ${channelId}`,
    }, null, 2);
  } catch (error) {
    return JSON.stringify({ ok: false, error: error.message }, null, 2);
  }
}

export default run;
