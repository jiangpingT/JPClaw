/**
 * GitHub 代码同步 Skill
 *
 * 每日自动将关注的 GitHub 开源项目同步到本地。
 * 支持多项目配置，自动判断首次 Clone 还是增量 Pull，
 * 记录新增提交并推送摘要到 Discord / Telegram。
 */

import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HttpsProxyAgent } from "https-proxy-agent";
import { sendToTelegram } from "../_shared/proactive-utils.js";

// ─── 默认配置 ────────────────────────────────────────────────────────────────

const DEFAULT_REPOS = [
  {
    name: "OpenClaw",
    repo: "https://github.com/openclaw/openclaw",
    localPath: "/Users/mlamp/Workspace/OpenClaw",
    branch: "main",
  },
];

const DEFAULT_CHANNEL_ID = process.env.DEFAULT_DISCORD_CHANNEL_ID;
const DISCORD_MSG_LIMIT = 2000;

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function runCommand(cmd, options = {}) {
  return new Promise((resolve, reject) => {
    exec(
      cmd,
      {
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
        shell: "/bin/zsh",
        ...options,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `命令失败: ${cmd}\n${error.message}\n${stderr || stdout}`
            )
          );
          return;
        }
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      }
    );
  });
}

function getProxyAgent() {
  const proxyUrl =
    process.env.DISCORD_PROXY_URL ||
    process.env.https_proxy ||
    process.env.http_proxy;
  if (!proxyUrl) return undefined;
  return new HttpsProxyAgent(proxyUrl);
}

function todayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ─── 同步单个项目 ────────────────────────────────────────────────────────────

async function syncRepo({ name, repo, localPath, branch = "main" }) {
  const result = {
    name,
    repo,
    localPath,
    ok: false,
    action: "",
    newCommits: 0,
    commits: [],
    error: null,
  };

  try {
    const isGitRepo =
      fs.existsSync(localPath) &&
      fs.existsSync(path.join(localPath, ".git"));

    if (!isGitRepo) {
      // ── 首次 Clone ──
      result.action = "clone";
      const parentDir = path.dirname(localPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      await runCommand(`git clone "${repo}" "${localPath}"`);

      const { stdout } = await runCommand(
        `git -C "${localPath}" log -5 --pretty=format:"%h %s" HEAD`
      );
      result.commits = stdout ? stdout.split("\n").filter(Boolean) : [];
      result.newCommits = result.commits.length;
    } else {
      // ── 增量 Pull ──
      result.action = "pull";

      const { stdout: beforeHash } = await runCommand(
        `git -C "${localPath}" rev-parse HEAD`
      );

      // 获取上游最新代码
      await runCommand(`git -C "${localPath}" fetch --all --prune`);

      // 自动检测默认分支（symbolic-ref 优先，fallback 到参数）
      let targetBranch = branch;
      try {
        const { stdout: symRef } = await runCommand(
          `git -C "${localPath}" symbolic-ref --short HEAD`
        );
        if (symRef) targetBranch = symRef;
      } catch { /* 保持默认 */ }

      await runCommand(
        `git -C "${localPath}" reset --hard "origin/${targetBranch}"`
      );

      const { stdout: afterHash } = await runCommand(
        `git -C "${localPath}" rev-parse HEAD`
      );

      if (beforeHash !== afterHash) {
        const { stdout: log } = await runCommand(
          `git -C "${localPath}" log "${beforeHash}..HEAD" --pretty=format:"%h %s"`
        );
        result.commits = log ? log.split("\n").filter(Boolean) : [];
        result.newCommits = result.commits.length;
      }
    }

    result.ok = true;
  } catch (err) {
    result.ok = false;
    result.error = err.message;
  }

  return result;
}

// ─── 构建通知消息 ────────────────────────────────────────────────────────────

function buildMessage(results) {
  const date = todayString();
  const lines = [`🔄 GitHub 代码同步报告 | ${date}`, ""];

  for (const r of results) {
    if (r.ok) {
      const actionLabel = r.action === "clone" ? "首次 Clone" : "Pull 更新";
      const status =
        r.newCommits > 0
          ? `✅ ${actionLabel} · ${r.newCommits} 个新提交`
          : `✅ ${actionLabel} · 已是最新`;
      lines.push(`**${r.name}** ${status}`);
      for (const c of r.commits.slice(0, 5)) {
        lines.push(`  • \`${c}\``);
      }
    } else {
      lines.push(`**${r.name}** ❌ 同步失败`);
      lines.push(`  • ${r.error}`);
    }
    lines.push("");
  }

  const allOk = results.every((r) => r.ok);
  lines.push("---");
  lines.push(
    `JPClaw GitHub 同步 · 自动生成 · ${allOk ? "全部成功" : "部分失败"}`
  );

  return lines.join("\n");
}

// ─── Discord 推送 ────────────────────────────────────────────────────────────

async function sendToDiscord(channelId, content) {
  const token =
    process.env.DISCORD_TOKEN || process.env.DISCORD_BOT1_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN 或 DISCORD_BOT1_TOKEN 未配置");

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

function splitMessage(text, limit) {
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

// ─── 主入口 ──────────────────────────────────────────────────────────────────

export async function run(input) {
  try {
    let params = {};
    try {
      params = typeof input === "string" ? JSON.parse(input) : input || {};
    } catch {
      params = {};
    }

    const repos = params.repos || DEFAULT_REPOS;
    const channelId = params.channelId || DEFAULT_CHANNEL_ID;
    const telegramChatId =
      params.telegramChatId || process.env.DEFAULT_TELEGRAM_CHAT_ID;

    // 顺序同步（避免并发 git 操作互相干扰）
    const results = [];
    for (const repoConfig of repos) {
      const result = await syncRepo(repoConfig);
      results.push(result);
    }

    const message = buildMessage(results);

    let discordMessageIds = [];
    if (channelId) {
      try {
        discordMessageIds = await sendToDiscord(channelId, message);
      } catch (e) {
        discordMessageIds = [`error: ${e.message}`];
      }
    }

    let telegramMessageIds = [];
    if (telegramChatId) {
      try {
        telegramMessageIds = await sendToTelegram(telegramChatId, message);
      } catch (e) {
        telegramMessageIds = [`error: ${e.message}`];
      }
    }

    return JSON.stringify(
      {
        ok: true,
        date: todayString(),
        results,
        discordMessageIds,
        telegramMessageIds,
        message: "GitHub 代码同步完成",
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
