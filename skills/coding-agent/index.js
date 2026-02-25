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
 *
 * 续接语法（手机友好）：
 *   @coding-agent --continue 按刚才的 plan 实现
 *   @coding-agent --resume ca_xxx 测试没过，继续修
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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

/**
 * 扫描 ~/.claude/projects/ 找最近创建的 claude session UUID
 * claude 在启动后会在此目录创建 <uuid>.jsonl 文件
 * @param {number} startedAfterMs - 只查找此时间戳之后创建的文件
 * @returns {string|null} session UUID 或 null
 */
function findClaudeSessionId(startedAfterMs) {
  try {
    const claudeDir = path.join(os.homedir(), ".claude", "projects");
    if (!fs.existsSync(claudeDir)) return null;

    let newest = null;
    let newestTime = 0;

    for (const proj of fs.readdirSync(claudeDir)) {
      const projDir = path.join(claudeDir, proj);
      try {
        if (!fs.statSync(projDir).isDirectory()) continue;
        for (const f of fs.readdirSync(projDir)) {
          if (!f.endsWith(".jsonl")) continue;
          const fp = path.join(projDir, f);
          const stat = fs.statSync(fp);
          // birthtimeMs 更精确；部分 fs 不支持时回退 mtimeMs
          const created = stat.birthtimeMs || stat.mtimeMs;
          if (created >= startedAfterMs && created > newestTime) {
            newestTime = created;
            newest = f.replace(".jsonl", "");
          }
        }
      } catch {}
    }
    return newest;
  } catch {
    return null;
  }
}

// ─── 核心：启动 claude -p 执行任务 ───────────────────────────────────────────

async function startSession({
  task, workdir, tool, notifyOnDone, channelId, telegramChatId,
  resumeClaudeSessionId,   // claude 内部 UUID，用于 --resume
}) {
  const id = genId();
  const startedAtMs = Date.now();

  const session = {
    id,
    task,
    workdir,
    tool,
    status: "running",
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: null,
    exitCode: null,
    lines: [],          // 最近 500 行输出
    claudeSessionId: null,  // claude 内部 UUID（异步填充）
  };
  sessions.set(id, session);
  persistSessions();

  // 构建命令
  const bin = tool === "claude" ? CLAUDE_BIN : (tool || CLAUDE_BIN);
  let args;
  if (tool === "codex") {
    args = ["exec", "--full-auto", task];
  } else {
    args = [];
    if (resumeClaudeSessionId) {
      // 续接上一个 claude 对话，保留完整上下文
      args.push("--resume", resumeClaudeSessionId);
    }
    args.push("-p", task, "--dangerously-skip-permissions");
    // 注意：已去掉 --no-session-persistence，以支持 --resume
  }

  const proc = spawn(bin, args, {
    cwd: workdir,
    env: {
      ...process.env,
      CI: "true",
      NO_COLOR: "1",
      TERM: "dumb",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // 续接模式：直接继承父 session 的 claude UUID（--resume 不创建新文件）
  if (resumeClaudeSessionId) {
    session.claudeSessionId = resumeClaudeSessionId;
    persistSessions();
  }

  // 存 proc 引用（不持久化）
  session.proc = proc;

  const appendLine = (text) => {
    const clean = text.replace(ANSI_RE, "");
    const newLines = clean.split("\n");
    session.lines.push(...newLines);
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

  // 3 秒后捕获 claude session ID（claude 启动时会立即创建 .jsonl 文件）
  setTimeout(() => {
    if (!session.claudeSessionId) {
      const sid = findClaudeSessionId(startedAtMs - 500);
      if (sid) {
        session.claudeSessionId = sid;
        persistSessions();
      }
    }
  }, 3000);

  proc.on("exit", async (code) => {
    session.status = code === 0 ? "done" : "failed";
    session.exitCode = code;
    session.endedAt = new Date().toISOString();

    // 任务结束时再补捉一次（防止 3 秒内 claude 还未写文件）
    if (!session.claudeSessionId) {
      const sid = findClaudeSessionId(startedAtMs - 500);
      if (sid) session.claudeSessionId = sid;
    }

    persistSessions();

    if (!notifyOnDone) return;

    const summary = session.lines.slice(-30).join("\n").trim().slice(0, 1200);
    const emoji = code === 0 ? "✅" : "❌";
    const shortTask = task.length > 120 ? task.slice(0, 117) + "…" : task;
    // 在通知里带上 sessionId，方便手机直接复制续接
    const resumeTip = session.claudeSessionId
      ? `\n💡 续接：\`@coding-agent --resume ${id} 你的下一步\``
      : "";
    const msg = [
      `${emoji} **Coding Agent ${code === 0 ? "完成" : "失败"}**`,
      `📁 \`${path.basename(workdir)}\``,
      `🎯 ${shortTask}`,
      `🆔 \`${id}\`${resumeTip}`,
      summary ? `\n\`\`\`\n${summary}\n\`\`\`` : "",
    ].join("\n");

    await Promise.allSettled([
      channelId      ? sendToDiscord(channelId, msg)        : Promise.resolve(),
      telegramChatId ? sendToTelegram(telegramChatId, msg)  : Promise.resolve(),
    ]);
  });

  return id;
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

export async function run(input) {
  try {
    let params = {};
    if (typeof input === "string") {
      const s = input.trim();

      // 手机友好的续接语法（无需 JSON）：
      //   --continue 下一步任务描述
      //   --resume ca_xxx 下一步任务描述
      if (s.startsWith("--continue ")) {
        params = { action: "start", task: s.slice("--continue ".length).trim(), continue: true };
      } else if (/^--resume\s+\S+\s+/s.test(s)) {
        const m = s.match(/^--resume\s+(\S+)\s+([\s\S]+)$/);
        if (m) params = { action: "start", task: m[2].trim(), resumeSessionId: m[1] };
      } else {
        try {
          params = JSON.parse(s);
        } catch {
          // 纯自然语言 → 当作新任务
          params = { action: "start", task: s };
        }
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

      // 解析续接目标：找到上一个 session 的 claude UUID
      let resumeClaudeSessionId;

      if (params.resumeSessionId) {
        // 精确续接：指定 ca_xxx session
        const prev = sessions.get(params.resumeSessionId);
        if (!prev) {
          return JSON.stringify({ ok: false, error: `找不到 session: ${params.resumeSessionId}` });
        }
        if (!prev.claudeSessionId) {
          return JSON.stringify({ ok: false, error: `session ${params.resumeSessionId} 暂无 claude session ID（可能任务还在运行中）` });
        }
        resumeClaudeSessionId = prev.claudeSessionId;
      } else if (params.continue) {
        // 模糊续接：找同一 workdir 下最近完成的 session
        const prev = Array.from(sessions.values())
          .filter(s => s.workdir === dir && s.claudeSessionId && s.status !== "running")
          .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0];
        if (!prev) {
          return JSON.stringify({ ok: false, error: `在 ${path.basename(dir)} 找不到可续接的 session，请先启动一个任务` });
        }
        resumeClaudeSessionId = prev.claudeSessionId;
      }

      const id = await startSession({
        task, workdir: dir, tool, notifyOnDone, channelId, telegramChatId,
        resumeClaudeSessionId,
      });

      return JSON.stringify({
        ok: true,
        sessionId: id,
        status: "started",
        workdir: dir,
        resumed: !!resumeClaudeSessionId,
        message: resumeClaudeSessionId
          ? `✅ 已在 ${path.basename(dir)} 继续上一个 claude 会话（sessionId: ${id}）`
          : `✅ 已在 ${path.basename(dir)} 启动 ${tool}，完成后会通知你（sessionId: ${id}）`,
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
        claudeSessionId: s.claudeSessionId,
        recentOutput: recent.slice(-800),
      });
    }

    // ── log ───────────────────────────────────────────────────────────────────
    if (action === "log") {
      const s = sessions.get(sessionId);
      if (!s) return JSON.stringify({ ok: false, error: `session ${sessionId} 不存在` });
      return JSON.stringify({
        ok: true, sessionId, status: s.status,
        claudeSessionId: s.claudeSessionId,
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
        canResume: !!s.claudeSessionId,
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
