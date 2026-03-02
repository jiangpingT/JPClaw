/**
 * Proactive Plan Brief (Plan 备忘录最新动态播报)
 *
 * 任务执行时，取所有以 [Plan] 开头的 Apple Notes 备忘录，
 * 按修改时间排序，读取最近修改的 topN 条，
 * 由 AI 提取最新添加的内容，汇总推送到 Discord / Telegram。
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HttpsProxyAgent } from "https-proxy-agent";
import { sendToTelegram } from "../_shared/proactive-utils.js";

const execAsync = promisify(exec);
const MEMO = "/opt/homebrew/bin/memo";

// ─── 配置 ────────────────────────────────────────────────────────────────────

const DEFAULT_TOP_N = 5;
const PLAN_PREFIX = "[Plan]";           // 只处理以此开头的备忘录
const DEFAULT_CHANNEL_ID = process.env.DEFAULT_DISCORD_CHANNEL_ID;
const DISCORD_MSG_LIMIT = 2000;

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function nowString() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function getProxyAgent() {
  const proxyUrl =
    process.env.DISCORD_PROXY_URL ||
    process.env.https_proxy ||
    process.env.http_proxy;
  if (!proxyUrl) return undefined;
  return new HttpsProxyAgent(proxyUrl);
}

// ─── 解析 osascript 输出的中文日期 ──────────────────────────────────────────
// 格式：Plan计划 | 2026年2月26日 星期四 01:21:28

function parseChineseDate(str) {
  const m = str.match(/(\d+)年(\d+)月(\d+)日\s+\S+\s+(\d+):(\d+):(\d+)/);
  if (!m) return null;
  return new Date(
    parseInt(m[1]),
    parseInt(m[2]) - 1,
    parseInt(m[3]),
    parseInt(m[4]),
    parseInt(m[5]),
    parseInt(m[6])
  );
}

// ─── 执行 AppleScript（shell 继承 Automation 权限，绕过 execFile 权限限制）──

async function runAppleScript(script) {
  const tmpFile = path.join(os.tmpdir(), `jpclaw-notes-${Date.now()}.applescript`);
  fs.writeFileSync(tmpFile, script, "utf-8");
  try {
    const { stdout } = await execAsync(`osascript "${tmpFile}"`, {
      shell: "/bin/zsh",
      timeout: 30000,
    });
    return stdout;
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

// ─── 获取 [Plan] 备忘录列表（含修改时间）────────────────────────────────────

async function getPlanNotesWithModTime() {
  const stdout = await runAppleScript(`
tell application "Notes"
  set output to ""
  set theNotes to notes
  repeat with n in theNotes
    set noteName to name of n
    if noteName starts with "${PLAN_PREFIX}" then
      set modDate to modification date of n
      set output to output & noteName & " | " & (modDate as string) & linefeed
    end if
  end repeat
  return output
end tell`);

  const lines = stdout.trim().split("\n").filter(Boolean);
  const result = [];

  for (const line of lines) {
    const sepIdx = line.indexOf(" | ");
    if (sepIdx === -1) continue;
    const name = line.slice(0, sepIdx).trim();
    const dateStr = line.slice(sepIdx + 3).trim();
    const modTime = parseChineseDate(dateStr);
    if (name && modTime) {
      result.push({ name, modTime });
    }
  }

  // 按修改时间降序排序，然后按名字去重（保留最新的）
  result.sort((a, b) => b.modTime - a.modTime);
  const seen = new Set();
  return result.filter(({ name }) => {
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

// ─── 用 memo 获取完整备忘录列表（名称 → 索引 映射）────────────────────────

async function getMemoIndexMap() {
  const { stdout } = await execAsync(`"${MEMO}" notes`, {
    shell: "/bin/zsh",
    timeout: 30000,
  });
  const map = new Map();
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\.\s+(.+?)\s+-\s+(.+)$/);
    if (m) map.set(m[3].trim(), m[1].trim());
  }
  return map;
}

// ─── 用 memo 读取单个备忘录内容（按索引）────────────────────────────────────

async function readNoteByIndex(index) {
  const { stdout } = await execAsync(
    `"${MEMO}" notes --view ${index}`,
    { shell: "/bin/zsh", timeout: 30000 }
  );
  return stdout.trim() || null;
}

// ─── AI 提取最新内容并生成播报 ───────────────────────────────────────────────

async function generateBrief(notesWithContent, executionTime) {
  const baseUrl =
    process.env.ANTHROPIC_BASE_URL || "https://vibe.deepminer.ai";
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!authToken) throw new Error("ANTHROPIC_AUTH_TOKEN 未配置");

  const systemPrompt = `你是姜哥的助手「阿策」，负责播报他 Apple Notes 中 [Plan] 系列备忘录的最新动态。

## 任务
以下是最近修改的 [Plan] 备忘录全量内容。对每个备忘录：
1. 判断哪些内容看起来是最近新增的（参考日期标记如「MMDD」、内容位置、段落结构等）
2. 提取并简洁呈现这些最新内容

## 输出格式

📋 Plan 备忘录动态 | ${executionTime}

**【备忘录名称】** 最近修改：HH:MM
• 条目1
• 条目2

（多个备忘录依次列出）

---
JPClaw 备忘录播报 · 自动生成

## 原则
- 保持原始措辞，不改写内容
- 如果无法判断哪部分是新增的，呈现最后几行内容即可
- 总长度控制在 800 字符以内，全程中文`;

  const contextParts = notesWithContent.map(({ name, modTime, content }) => {
    const timeStr = modTime.toLocaleTimeString("zh-CN", { hour12: false });
    // 只取末尾 1500 字符，越新的内容越靠后
    const truncated =
      content.length > 1500
        ? "（内容已截取末尾 1500 字符）\n" + content.slice(-1500)
        : content;
    return `【${name}】（最近修改：${timeStr}）\n${truncated}`;
  });

  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 768,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `最近修改的 [Plan] 备忘录：\n\n${contextParts.join("\n\n---\n\n")}`,
      },
    ],
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
  return result?.content?.[0]?.text || "播报生成失败";
}

// ─── Discord 推送 ────────────────────────────────────────────────────────────

function splitMessage(text, limit) {
  if (text.length <= limit) return [text];
  const segments = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) { segments.push(remaining); break; }
    let splitIndex = remaining.lastIndexOf("\n", limit);
    if (splitIndex <= 0) splitIndex = limit;
    segments.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).replace(/^\n/, "");
  }
  return segments;
}

async function sendToDiscord(channelId, content) {
  const token = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT1_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN 或 DISCORD_BOT1_TOKEN 未配置");

  const messageIds = [];
  for (const segment of splitMessage(content, DISCORD_MSG_LIMIT)) {
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
      throw new Error(`Discord API error: ${response.status} ${errText}`);
    }
    const data = await response.json();
    if (data.id) messageIds.push(data.id);
  }
  return messageIds;
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

export async function run(input) {
  try {
    let params = {};
    try {
      params = typeof input === "string" ? JSON.parse(input) : input || {};
    } catch {
      params = {};
    }

    const topN = params.topN ?? DEFAULT_TOP_N;
    const channelId = params.channelId || DEFAULT_CHANNEL_ID;
    const telegramChatId =
      params.telegramChatId || process.env.DEFAULT_TELEGRAM_CHAT_ID;

    const executionTime = nowString();

    // ① 获取 [Plan] 备忘录列表（按修改时间降序），取最近 topN 个
    const allPlanNotes = await getPlanNotesWithModTime();

    if (allPlanNotes.length === 0) {
      return JSON.stringify({
        ok: false,
        error: `未找到任何 ${PLAN_PREFIX} 开头的备忘录`,
      });
    }

    const topNotes = allPlanNotes.slice(0, topN);

    // ② 获取 memo 索引表（只调用一次），然后顺序读取每条内容
    const indexMap = await getMemoIndexMap();
    const notesWithContent = [];
    for (const { name, modTime } of topNotes) {
      const idx = indexMap.get(name);
      if (!idx) continue;
      const content = await readNoteByIndex(idx);
      if (content) notesWithContent.push({ name, modTime, content });
    }

    if (notesWithContent.length === 0) {
      return JSON.stringify({ ok: false, error: "备忘录内容读取失败" });
    }

    // ③ AI 生成播报
    const briefContent = await generateBrief(notesWithContent, executionTime);

    // ④ Discord 推送
    let discordMessageIds = [];
    if (channelId) {
      try { discordMessageIds = await sendToDiscord(channelId, briefContent); }
      catch (e) { discordMessageIds = [`error: ${e.message}`]; }
    }

    // ⑤ Telegram 推送
    let telegramMessageIds = [];
    if (telegramChatId) {
      try { telegramMessageIds = await sendToTelegram(telegramChatId, briefContent); }
      catch (e) { telegramMessageIds = [`error: ${e.message}`]; }
    }

    return JSON.stringify(
      {
        ok: true,
        executionTime,
        topNotes: topNotes.map((n) => ({
          name: n.name,
          modTime: n.modTime.toISOString(),
        })),
        discordMessageIds,
        telegramMessageIds,
        message: `Plan 备忘录动态播报完成（读取 ${notesWithContent.length} 条）`,
      },
      null,
      2
    );
  } catch (error) {
    return JSON.stringify(
      { ok: false, error: error.message, stack: error.stack },
      null,
      2
    );
  }
}

export default run;
