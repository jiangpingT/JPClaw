/**
 * Coding Agent Skill — 真正执行 claude CLI 的实现层
 *
 * 接收编程任务，在后台启动 claude -p（非交互式）执行，
 * 完成后自动通过 notify 推送到 Discord + Telegram。
 *
 * Actions:
 *   start  — 启动新任务，返回 sessionId
 *   status — 查看最近输出和状态
 *   log    — 查看完整输出
 *   list   — 列出所有会话
 *   kill   — 终止指定会话
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  sendToDiscord, sendToTelegram, ensureDir, BRAIN_DIR,
} from "../_shared/proactive-utils.js";

// ─── 配置 ────────────────────────────────────────────────────────────────────

const CLAUDE_BIN = process.env.CLAUDE_BIN
  || "/Users/mlamp/.local/bin/claude"
  || "/opt/homebrew/bin/claude"
  || "claude";

const DEFAULT_WORKDIR = "/Users/mlamp/Workspace/JPClaw";

const SESSIONS_FILE = path.join(BRAIN_DIR, "coding-agent-sessions.json");

// 匹配 ANSI 转义码（strip 用于干净输出）
const ANSI_RE = /\x1b\[[0-9;]*[mGKHFJA-Z]/g;

// ─── Session Store（内存 + 文件持久化）───────────────────────────────────────

/** @type {Map<string, object>} */
const sessions = new Map();

function persistSessions() {
  try {
    const data = Array.from(sessions.values()).map(({ proc, ...rest }) => rest);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch {}
}

function loadSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
    for (const s of data) {
      // 重启后进程已消失，将 running 标记为 unknown
      if (s.status === "running") s.status = "unknown(restarted)";
      sessions.set(s.id, s);
    }
  } catch {}
}

// 启动时恢复历史会话
loadSessions();

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function genId() {
  return `ca_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** 推断工作目录：从任务文本中识别项目名 */
function inferWorkdir(task) {
  if (/JPRobot|jp[\s-]?robot|机器人|robot[\s-]?dog/i.test(task)) {
    return "/Users/mlamp/Workspace/JPRobot";
  }
  return DEFAULT_WORKDIR;
}

// ─── 核心：启动 claude -p 执行任务 ───────────────────────────────────────────

async function startSession({ task, workdir, tool, notifyOnDone, channelId, telegramChatId }) {
  const id = genId();

  const session = {
    id,
    task,
    workdir,
    tool,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    lines: [],   // 最近 500 行输出
  };
  sessions.set(id, session);
  persistSessions();

  // 构建命令
  const bin = tool === "claude" ? CLAUDE_BIN : (tool || CLAUDE_BIN);
  const args = tool === "codex"
    ? ["exec", "--full-auto", task]
    : ["-p", task, "--dangerously-skip-permissions", "--no-session-persistence"];

  const proc = spawn(bin, args, {
    cwd: workdir,
    env: {
      ...process.env,
      // 告知 claude 在 CI/非交互环境运行
      CI: "true",
      NO_COLOR: "1",
      TERM: "dumb",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // 存 proc 引用（不持久化）
  session.proc = proc;

  const appendLine = (text) => {
    const clean = text.replace(ANSI_RE, "");
    // 按换行拆分，逐行存储
    const newLines = clean.split("\n");
    session.lines.push(...newLines);
    // 最多保留 500 行
    if (session.lines.length > 500) {
      session.lines.splice(0, session.lines.length - 500);
    }
  };

  proc.stdout.on("data", (chunk) => appendLine(chunk.toString()));
  proc.stderr.on("data", (chunk) => appendLine(chunk.toString()));

  proc.on("error", (err) => {
    session.lines.push(`[spawn error] ${err.message}`);
    session.status = "error";
    session.endedAt = new Date().toISOString();
    persistSessions();
  });

  proc.on("exit", async (code) => {
    session.status = code === 0 ? "done" : "failed";
    session.exitCode = code;
    session.endedAt = new Date().toISOString();
    persistSessions();

    if (!notifyOnDone) return;

    // 取最后 30 行作为摘要
    const summary = session.lines.slice(-30).join("\n").trim().slice(0, 1200);
    const emoji = code === 0 ? "✅" : "❌";
    const shortTask = task.length > 120 ? task.slice(0, 117) + "…" : task;
    const msg = [
      `${emoji} **Coding Agent ${code === 0 ? "完成" : "失败"}**`,
      `📁 \`${path.basename(workdir)}\``,
      `🎯 ${shortTask}`,
      summary ? `\n\`\`\`\n${summary}\n\`\`\`` : "",
    ].join("\n");

    await Promise.allSettled([
      channelId   ? sendToDiscord(channelId, msg)       : Promise.resolve(),
      telegramChatId ? sendToTelegram(telegramChatId, msg) : Promise.resolve(),
    ]);
  });

  return id;
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

export async function run(input) {
  try {
    // 兼容两种调用方式：
    // 1. JSON：{"action":"start","task":"...","workdir":"..."}
    // 2. 自然语言字符串：直接作为 task（由 skill_router 传入用户消息）
    let params = {};
    if (typeof input === "string") {
      try {
        params = JSON.parse(input);
      } catch {
        // 非 JSON → 把整个字符串当作 task
        params = { action: "start", task: input };
      }
    } else {
      params = input || {};
    }

    const {
      action         = "start",
      task,
      workdir,
      tool           = "claude",
      sessionId,
      notifyOnDone   = true,
      channelId      = process.env.DEFAULT_DISCORD_CHANNEL_ID,
      telegramChatId = process.env.DEFAULT_TELEGRAM_CHAT_ID,
    } = params;

    // ── start ─────────────────────────────────────────────────────────────────
    if (action === "start") {
      if (!task || !task.trim()) {
        return JSON.stringify({ ok: false, error: "task 参数必填（要做什么？）" });
      }
      const dir = workdir || inferWorkdir(task);
      if (!fs.existsSync(dir)) {
        return JSON.stringify({ ok: false, error: `workdir 不存在: ${dir}` });
      }
      const id = await startSession({ task, workdir: dir, tool, notifyOnDone, channelId, telegramChatId });
      return JSON.stringify({
        ok: true,
        sessionId: id,
        status: "started",
        workdir: dir,
        message: `✅ 已在 ${path.basename(dir)} 启动 ${tool}，完成后会通知你（sessionId: ${id}）`,
      });
    }

    // ── status ────────────────────────────────────────────────────────────────
    if (action === "status") {
      const s = sessions.get(sessionId);
      if (!s) return JSON.stringify({ ok: false, error: `session ${sessionId} 不存在` });
      const recent = s.lines.slice(-15).join("\n");
      return JSON.stringify({
        ok: true, sessionId, status: s.status,
        startedAt: s.startedAt, endedAt: s.endedAt,
        recentOutput: recent.slice(-800),
      });
    }

    // ── log ───────────────────────────────────────────────────────────────────
    if (action === "log") {
      const s = sessions.get(sessionId);
      if (!s) return JSON.stringify({ ok: false, error: `session ${sessionId} 不存在` });
      return JSON.stringify({
        ok: true, sessionId, status: s.status,
        output: s.lines.join("\n").slice(-5000),
      });
    }

    // ── list ──────────────────────────────────────────────────────────────────
    if (action === "list") {
      const list = Array.from(sessions.values()).map(s => ({
        id: s.id,
        task: (s.task || "").slice(0, 80),
        status: s.status,
        workdir: path.basename(s.workdir || ""),
        startedAt: s.startedAt,
        endedAt: s.endedAt,
      }));
      return JSON.stringify({ ok: true, sessions: list });
    }

    // ── kill ──────────────────────────────────────────────────────────────────
    if (action === "kill") {
      const s = sessions.get(sessionId);
      if (!s) return JSON.stringify({ ok: false, error: `session ${sessionId} 不存在` });
      s.proc?.kill("SIGTERM");
      s.status = "killed";
      s.endedAt = new Date().toISOString();
      persistSessions();
      return JSON.stringify({ ok: true, sessionId, status: "killed" });
    }

    return JSON.stringify({ ok: false, error: `未知 action: ${action}` });

  } catch (e) {
    return JSON.stringify({ ok: false, error: e.message });
  }
}

export default run;
