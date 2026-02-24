/**
 * Workspace Status Skill
 *
 * 聚合多个项目的 git 状态、最近提交、开放 PR，
 * 生成专为手机小屏优化的文本快照并推送到 Discord。
 */

import { sendToDiscord, sendToTelegram, sh } from "../_shared/proactive-utils.js";

const DEFAULT_PROJECTS = [
  "/Users/mlamp/Workspace/JPClaw",
  "/Users/mlamp/Workspace/JPRobot",
];

const DEFAULT_CHANNEL_ID = "1469204772379693222";
const DEFAULT_TELEGRAM_ID = "-1003855994917";

/**
 * 将相对时间格式化为可读字符串（如 "2h ago"）
 */
function relativeTime(isoStr) {
  if (!isoStr) return "";
  const diffMs = Date.now() - new Date(isoStr).getTime();
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.round(diffH / 24)}d ago`;
}

/**
 * 解析 git log --oneline -5 --format="%h %s %ci" 输出
 */
function parseGitLog(raw) {
  if (!raw) return [];
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      // 格式：hash subject 2026-02-24 11:00:00 +0800
      const match = line.match(/^(\S+)\s+(.+?)\s+(\d{4}-\d{2}-\d{2}T\S+)$/);
      if (match) {
        return { hash: match[1], subject: match[2], time: relativeTime(match[3]) };
      }
      // 降级：直接取前两段
      const parts = line.split(" ");
      return { hash: parts[0], subject: parts.slice(1).join(" "), time: "" };
    });
}

/**
 * 扫描单个项目，返回状态数据
 */
async function scanProject(projectPath) {
  const name = projectPath.split("/").pop();
  const cwd = projectPath;

  const [statusRaw, logRaw, prRaw] = await Promise.allSettled([
    sh("git status --short", { cwd, allowFail: true }),
    sh('git log --oneline -5 --format="%H %s %aI"', { cwd, allowFail: true }),
    sh("gh pr list --limit 3 --json number,title,state 2>/dev/null || echo '[]'", {
      cwd,
      allowFail: true,
    }),
  ]);

  const statusLines = statusRaw.status === "fulfilled"
    ? statusRaw.value.split("\n").filter(Boolean)
    : [];

  const commits = logRaw.status === "fulfilled" ? parseGitLog(logRaw.value) : [];

  let prs = [];
  if (prRaw.status === "fulfilled") {
    try {
      prs = JSON.parse(prRaw.value || "[]");
    } catch {
      prs = [];
    }
  }

  return { name, projectPath, statusLines, commits, prs };
}

/**
 * 根据扫描结果构建格式化报告
 */
function buildReport(results) {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const lines = [`📊 工作台状态 | ${dateStr}`, ""];

  for (const r of results) {
    lines.push(`📁 ${r.name}`);

    if (r.statusLines.length === 0) {
      lines.push("  ✅ 工作区干净");
    } else {
      lines.push(`  ⚠️ 未提交：${r.statusLines.length} 个文件`);
      // 最多显示 5 个文件，避免太长
      const shown = r.statusLines.slice(0, 5);
      for (const f of shown) {
        lines.push(`    · ${f.trim()}`);
      }
      if (r.statusLines.length > 5) {
        lines.push(`    · ... 共 ${r.statusLines.length} 个`);
      }
    }

    if (r.commits.length > 0) {
      lines.push("  📝 最近提交：");
      for (const c of r.commits.slice(0, 3)) {
        const timeStr = c.time ? ` (${c.time})` : "";
        lines.push(`    • ${c.hash.slice(0, 7)} ${c.subject}${timeStr}`);
      }
    }

    if (r.prs.length === 0) {
      lines.push("  🔀 暂无开放 PR");
    } else {
      for (const pr of r.prs) {
        const icon = pr.state === "OPEN" ? "🔀" : "✅";
        lines.push(`  ${icon} PR #${pr.number} ${pr.title} [${pr.state?.toLowerCase()}]`);
      }
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}

export async function run(input) {
  const params = typeof input === "string"
    ? (input.trim() ? JSON.parse(input) : {})
    : (input || {});

  const {
    projects = DEFAULT_PROJECTS,
    channelId = DEFAULT_CHANNEL_ID,
    telegramChatId = DEFAULT_TELEGRAM_ID,
    sendToChannel = true,
  } = params;

  const scanResults = await Promise.allSettled(
    projects.map((p) => scanProject(p))
  );

  const results = scanResults
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value);

  const report = buildReport(results);

  const notifications = [];
  if (sendToChannel && channelId) {
    notifications.push(sendToDiscord(channelId, report).catch((e) => `discord error: ${e.message}`));
  }
  if (sendToChannel && telegramChatId) {
    notifications.push(sendToTelegram(telegramChatId, report).catch((e) => `telegram error: ${e.message}`));
  }

  const notifyResults = await Promise.allSettled(notifications);

  return JSON.stringify({
    ok: true,
    report,
    notifications: notifyResults.map((r) =>
      r.status === "fulfilled" ? r.value : `error: ${r.reason}`
    ),
  });
}

export default run;
