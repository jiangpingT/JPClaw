import { exec } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "discord.js";
import { log } from "../shared/logger.js";

const REPO_ROOT = "/Users/mlamp/Workspace/JPClaw";
const MAX_REPLY = 1800;
const pendingByUser = new Map<string, PendingAction>();
const unauthorizedOpsByUser = new Map<string, number[]>();
const CONFIRM_TTL_MS = 2 * 60_000;
const ATTACK_WINDOW_MS = 2 * 60_000;
const ATTACK_THRESHOLD = 3;
const SECURITY_LOG_FILE = path.resolve(REPO_ROOT, "log", "security-events.log");
let shutdownTriggered = false;

type PendingAction = {
  token: string;
  expiresAt: number;
  description: string;
  run: () => Promise<string>;
};

export async function tryHandleOpsCommand(message: Message): Promise<boolean> {
  const content = message.content.trim();
  if (!content.startsWith("/ops")) return false;

  if (!isAdmin(message.author.id)) {
    const result = recordUnauthorizedOpsAttempt(message, content);
    if (result.shouldShutdown) {
      await safeReply(
        message,
        "检测到高风险未授权操作，已触发安全熔断并终止服务。请联系管理员处理。"
      );
      triggerSecurityShutdown(result.reason, message, content);
      return true;
    }
    await safeReply(message, "无权限：该指令仅允许管理员执行。");
    return true;
  }

  const arg = content.slice("/ops".length).trim();
  if (!arg || arg === "help") {
    await safeReply(
      message,
      [
        "可用命令：",
        "- /ops status",
        "- /ops restart",
        "- /ops exec <shell_command>",
        "",
        "示例：/ops exec sed -i '' 's/foo/bar/g' src/js/gateway/index.ts"
      ].join("\n")
    );
    return true;
  }

  if (arg === "status") {
    await safeReply(
      message,
      [
        `cwd: ${REPO_ROOT}`,
        `host: ${os.hostname()}`,
        `time: ${new Date().toISOString()}`,
        `pending: ${pendingByUser.has(message.author.id) ? "yes" : "no"}`,
        "提示：用 /ops exec <命令> 可直接改代码。"
      ].join("\n")
    );
    return true;
  }

  if (arg.startsWith("confirm ")) {
    const token = arg.slice("confirm ".length).trim();
    const pending = pendingByUser.get(message.author.id);
    if (!pending) {
      await safeReply(message, "当前没有待确认的操作。");
      return true;
    }
    if (pending.expiresAt < Date.now()) {
      pendingByUser.delete(message.author.id);
      await safeReply(message, "待确认操作已过期，请重新发送命令。");
      return true;
    }
    if (token !== pending.token) {
      await safeReply(message, "确认码错误，请检查后重试。");
      return true;
    }

    pendingByUser.delete(message.author.id);
    await safeReply(message, `已确认，开始执行：${pending.description}`);
    try {
      const output = await pending.run();
      await safeReply(message, asCodeBlock(truncate(output || "(无输出)", MAX_REPLY)));
    } catch (error) {
      await safeReply(message, `执行失败:\n${asCodeBlock(truncate(String(error), MAX_REPLY))}`);
    }
    return true;
  }

  if (arg === "restart") {
    const token = buildToken();
    pendingByUser.set(message.author.id, {
      token,
      expiresAt: Date.now() + CONFIRM_TTL_MS,
      description: "restart service",
      run: async () => {
        await runCommand("launchctl kickstart -k gui/$(id -u)/com.jpclaw.gateway", false);
        return "重启命令已提交。";
      }
    });
    await safeReply(
      message,
      [`重启属于危险操作，请确认。`, `请在 2 分钟内发送：/ops confirm ${token}`].join("\n")
    );
    return true;
  }

  if (arg.startsWith("exec ")) {
    const shellCommand = arg.slice("exec ".length).trim();
    if (!shellCommand) {
      await safeReply(message, "请输入要执行的命令，例如：/ops exec npm test");
      return true;
    }

    if (requiresConfirm(shellCommand)) {
      const token = buildToken();
      pendingByUser.set(message.author.id, {
        token,
        expiresAt: Date.now() + CONFIRM_TTL_MS,
        description: `exec ${shellCommand}`,
        run: async () => runCommand(shellCommand, true)
      });
      await safeReply(
        message,
        [
          `该命令需要二次确认：\`${shellCommand}\``,
          `请在 2 分钟内发送：/ops confirm ${token}`
        ].join("\n")
      );
      return true;
    }

    await safeReply(message, `执行中: \`${shellCommand}\``);
    try {
      const output = await runCommand(shellCommand, true);
      const text = output.trim() ? output : "(无输出)";
      await safeReply(message, asCodeBlock(truncate(text, MAX_REPLY)));
    } catch (error) {
      await safeReply(message, `执行失败:\n${asCodeBlock(truncate(String(error), MAX_REPLY))}`);
    }
    return true;
  }

  await safeReply(message, "未知命令。发送 /ops help 查看帮助。");
  return true;
}

function isAdmin(userId: string): boolean {
  const ids = getAdminIds();
  if (ids.length === 0) {
    log("error", "ops.admin_ids_missing", {
      message: "DISCORD_ADMIN_IDS is empty. Ops commands are hard-blocked."
    });
    return false;
  }
  return ids.includes(userId);
}

function getAdminIds(): string[] {
  const raw = process.env.DISCORD_ADMIN_IDS || "";
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function runCommand(command: string, includeStderr: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd: REPO_ROOT,
        timeout: 5 * 60_000,
        maxBuffer: 2 * 1024 * 1024,
        env: process.env,
        shell: "/bin/zsh"
      },
      (error, stdout, stderr) => {
        const output = includeStderr ? `${stdout}${stderr}` : stdout;
        if (error) {
          reject(new Error(`${error.message}\n${output}`));
          return;
        }
        resolve(output);
      }
    );
  });
}

function requiresConfirm(command: string): boolean {
  const lowered = command.toLowerCase();
  const riskyPatterns = [
    "rm ",
    "mv ",
    "cp ",
    "git reset",
    "git checkout --",
    "chmod ",
    "chown ",
    "launchctl ",
    "kill ",
    "pkill ",
    "sed -i",
    "perl -pi",
    ">>",
    "> ",
    "npm install",
    "npm uninstall"
  ];
  return riskyPatterns.some((pattern) => lowered.includes(pattern));
}

function buildToken(): string {
  return Math.random().toString(36).slice(2, 8);
}

async function safeReply(message: Message, text: string): Promise<void> {
  await message.reply(truncate(text, MAX_REPLY));
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 20)}\n...<truncated>`;
}

function asCodeBlock(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}

function recordUnauthorizedOpsAttempt(
  message: Message,
  content: string
): { shouldShutdown: boolean; reason: string } {
  const now = Date.now();
  const history = unauthorizedOpsByUser.get(message.author.id) || [];
  const recent = history.filter((ts) => now - ts <= ATTACK_WINDOW_MS);
  recent.push(now);
  unauthorizedOpsByUser.set(message.author.id, recent);

  const impersonation = looksLikeAdminImpersonation(content, message.author.id);
  const tooFrequent = recent.length >= ATTACK_THRESHOLD;
  const reason = impersonation ? "admin_impersonation_suspected" : "unauthorized_ops_burst";

  writeSecurityEvent("warn", "security.unauthorized_ops", {
    reason,
    userId: message.author.id,
    userTag: message.author.tag,
    channelId: message.channelId,
    attemptsInWindow: recent.length,
    content
  });

  return { shouldShutdown: impersonation || tooFrequent, reason };
}

function looksLikeAdminImpersonation(content: string, userId: string): boolean {
  const lowered = content.toLowerCase();
  const adminIds = getAdminIds();
  const usesAdminClaimWords =
    lowered.includes("我是管理员") ||
    lowered.includes("admin id") ||
    lowered.includes("adminid") ||
    lowered.includes("冒充") ||
    lowered.includes("伪装");
  const includesRealAdminId = adminIds.some((id) => content.includes(id) && id !== userId);
  return usesAdminClaimWords || includesRealAdminId;
}

function triggerSecurityShutdown(reason: string, message: Message, content: string): void {
  if (shutdownTriggered) return;
  shutdownTriggered = true;
  writeSecurityEvent("error", "security.shutdown", {
    reason,
    userId: message.author.id,
    userTag: message.author.tag,
    channelId: message.channelId,
    content
  });

  try {
    exec(
      "launchctl disable gui/$(id -u)/com.jpclaw.gateway && launchctl bootout gui/$(id -u)/com.jpclaw.gateway",
      {
        cwd: REPO_ROOT,
        env: process.env,
        shell: "/bin/zsh"
      },
      () => {
        // ignore callback result; process exits either way.
      }
    );
  } catch (error) {
    writeSecurityEvent("error", "security.shutdown.launchctl_failed", {
      error: String(error)
    });
  }

  setTimeout(() => {
    process.exit(1);
  }, 200);
}

function writeSecurityEvent(
  level: "warn" | "error",
  event: string,
  meta: Record<string, unknown>
): void {
  log(level, event, meta);
  const line = JSON.stringify({
    level,
    event,
    time: new Date().toISOString(),
    ...meta
  });
  try {
    mkdirSync(path.dirname(SECURITY_LOG_FILE), { recursive: true });
    appendFileSync(SECURITY_LOG_FILE, `${line}\n`);
  } catch (error) {
    log("error", "security.log.write_failed", { error: String(error) });
  }
}
