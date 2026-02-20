/**
 * Proactive Skills 共享工具模块
 *
 * 所有 proactive/ 下的 skill 共用的函数，
 * 避免重复代码，统一维护。
 */

import { exec, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HttpsProxyAgent } from "https-proxy-agent";

// ─── 常量 ────────────────────────────────────────────────────────────────────

export const DISCORD_MSG_LIMIT = 2000;
export const TELEGRAM_MSG_LIMIT = 4000;
export const CURL_TIMEOUT_MS = 20_000;
export const BRAIN_DIR = path.resolve(process.cwd(), "sessions", "brain");

// ─── 代理 ────────────────────────────────────────────────────────────────────

export function getProxyAgent() {
  const proxyUrl =
    process.env.DISCORD_PROXY_URL ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    "http://127.0.0.1:7890";
  if (!proxyUrl) return undefined;
  return new HttpsProxyAgent(proxyUrl);
}

// ─── 时间 ────────────────────────────────────────────────────────────────────

export function todayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function nowISO() {
  return new Date().toISOString();
}

// ─── 文件系统 ────────────────────────────────────────────────────────────────

export function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ─── Shell 执行 ──────────────────────────────────────────────────────────────

export function shellEscape(value) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

/**
 * 执行 shell 命令（用于简单的只读操作如 git status）
 */
export function sh(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(
      cmd,
      {
        timeout: opts.timeout || 30_000,
        maxBuffer: 4 * 1024 * 1024,
        cwd: opts.cwd || process.cwd(),
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        shell: "/bin/zsh",
      },
      (error, stdout, stderr) => {
        if (error && !opts.allowFail) {
          reject(new Error(`cmd failed: ${cmd}\n${stderr || error.message}`));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

/**
 * 安全执行命令 — 使用 execFile 避免 shell 注入
 * 参数数组直接传递，不经过 shell 解释
 */
export function safeExec(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: opts.timeout || 30_000,
        maxBuffer: 4 * 1024 * 1024,
        cwd: opts.cwd || process.cwd(),
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (error && !opts.allowFail) {
          reject(
            new Error(
              `execFile failed: ${command} ${args.join(" ")}\n${stderr || error.message}`
            )
          );
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

export function runCurl(url, extraArgs = []) {
  const proxyUrl =
    process.env.DISCORD_PROXY_URL ||
    process.env.https_proxy ||
    process.env.http_proxy;
  const proxyArg = proxyUrl ? `-x ${shellEscape(proxyUrl)}` : "";
  const extra = extraArgs.length > 0 ? " " + extraArgs.map(shellEscape).join(" ") : "";
  const cmd = `curl -sL ${proxyArg} --max-time 20 --retry 2 --retry-delay 1${extra} ${shellEscape(url)}`;

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

// ─── AI 调用 ─────────────────────────────────────────────────────────────────

/**
 * 调用 Anthropic API
 */
export async function callAnthropic(systemPrompt, userMessage, opts = {}) {
  const baseUrl =
    process.env.ANTHROPIC_BASE_URL || "https://vibe.deepminer.ai";
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!authToken) {
    throw new Error("ANTHROPIC_AUTH_TOKEN 未配置");
  }

  const body = {
    model: opts.model || "claude-sonnet-4-20250514",
    max_tokens: opts.maxTokens || 4096,
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

  const result = await response.json().catch((e) => {
    throw new Error(`Anthropic API 响应解析失败: ${e.message}`);
  });
  return result?.content?.[0]?.text || result?.completion || "";
}

/**
 * 调用 Anthropic API 并解析 JSON 返回
 * 健壮的 JSON 提取：直接解析 → code block → 花括号匹配
 */
export async function callAnthropicJSON(systemPrompt, userMessage, opts = {}) {
  const text = await callAnthropic(systemPrompt, userMessage, opts);
  return extractJSON(text);
}

/**
 * 从 AI 返回的文本中健壮地提取 JSON
 */
export function extractJSON(text) {
  const trimmed = text.trim();

  // 1. 尝试直接解析
  try {
    return JSON.parse(trimmed);
  } catch {}

  // 2. 尝试提取 code block 中的 JSON
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {}
  }

  // 3. 尝试找到第一个 { 和最后一个 } 之间的内容
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  throw new Error(
    `无法从 AI 返回中提取 JSON:\n${trimmed.slice(0, 300)}`
  );
}

// ─── 安全检查 ────────────────────────────────────────────────────────────────

/**
 * 检查文件路径是否在允许的项目范围内（防路径遍历）
 */
export function isPathSafe(basePath, filePath) {
  const resolved = path.resolve(basePath, filePath);
  return resolved.startsWith(basePath + path.sep) || resolved === basePath;
}

// ─── Discord ─────────────────────────────────────────────────────────────────

export async function sendToDiscord(channelId, content) {
  const token =
    process.env.DISCORD_TOKEN || process.env.DISCORD_BOT1_TOKEN;
  if (!token) {
    throw new Error("DISCORD_TOKEN 或 DISCORD_BOT1_TOKEN 未配置");
  }

  const messageIds = [];
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
      throw new Error(`Discord API error: ${response.status} ${errText}`);
    }

    const data = await response.json();
    if (data.id) messageIds.push(data.id);
  }

  return messageIds;
}

export function splitMessage(text, limit = DISCORD_MSG_LIMIT) {
  if (text.length <= limit) return [text];
  const segments = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      segments.push(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf("\n", limit);
    if (splitIndex <= 0) splitIndex = limit;
    segments.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).replace(/^\n/, "");
  }
  return segments;
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

export async function sendToTelegram(chatId, content) {
  const token = process.env.TELEGRAM_BOT1_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT1_TOKEN 未配置");
  }

  const messageIds = [];
  const segments = splitMessage(content, TELEGRAM_MSG_LIMIT);

  for (const segment of segments) {
    const agent = getProxyAgent();
    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    // 先尝试 Markdown，失败则回退纯文本
    let data;
    try {
      const fetchOptions = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: segment,
          parse_mode: "Markdown",
        }),
      };
      if (agent) fetchOptions.agent = agent;

      const response = await fetch(url, fetchOptions);
      data = await response.json();

      if (!data.ok) throw new Error(data.description || "Markdown 发送失败");
    } catch {
      // Markdown 解析失败，回退纯文本
      const fetchOptions = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: segment,
        }),
      };
      if (agent) fetchOptions.agent = agent;

      const response = await fetch(url, fetchOptions);
      data = await response.json();

      if (!data.ok) {
        throw new Error(`Telegram API error: ${data.description || response.status}`);
      }
    }

    if (data.result?.message_id) messageIds.push(data.result.message_id);
  }

  return messageIds;
}

// ─── RSS 解析 ────────────────────────────────────────────────────────────────

export function extractTag(xmlChunk, tag) {
  const match = xmlChunk.match(
    new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "i")
  );
  if (!match) return null;
  return match[0].replace(
    new RegExp(`^<${tag}>|<\\/${tag}>$`, "gi"),
    ""
  );
}

export function decodeXml(input) {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function parseRssItems(xml, source) {
  if (!xml.trim()) return [];
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  const output = [];
  for (const chunk of items) {
    const title = decodeXml(extractTag(chunk, "title") || "").trim();
    const link = decodeXml(extractTag(chunk, "link") || "").trim();
    const description = decodeXml(
      extractTag(chunk, "description") || ""
    ).trim();
    const pubDate = decodeXml(extractTag(chunk, "pubDate") || "").trim();
    if (!title || !link) continue;
    output.push({
      title: title.replace(/\s*-\s*[^-]{1,40}$/, "").trim(),
      link,
      description: description.slice(0, 300),
      pubDate,
      source,
    });
  }
  return output;
}
