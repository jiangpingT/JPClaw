/**
 * Daily Reminders Skill
 *
 * 每天早上 08:30 从 macOS 提醒事项拉取今日待办 + 逾期未完成事项，
 * 格式化后推送到 Discord + Telegram。
 * 依赖：remindctl（brew install steipete/tap/remindctl）
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sendToDiscord, sendToTelegram, sendToDmwork } from "../_shared/proactive-utils.js";

const execFileAsync = promisify(execFile);
const REMINDCTL = "/opt/homebrew/bin/remindctl";
const DEFAULT_CHANNEL_ID = "1469204772379693222";
const DEFAULT_TELEGRAM_ID = "-1003855994917";

// ─── remindctl 调用 ──────────────────────────────────────────────────────────

async function rcJSON(filter) {
  const { stdout } = await execFileAsync(
    REMINDCTL,
    ["show", filter, "--json", "--no-color", "--no-input"],
    { timeout: 30_000 }
  );
  return JSON.parse(stdout.trim() || "[]");
}

// ─── 时间格式化 ──────────────────────────────────────────────────────────────

function formatDue(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  // 没有具体时间（午夜 0:00）则只显示日期
  if (h === 0 && m === "00") return null;
  return `${h}:${m}`;
}

function todayWeekday() {
  const now = new Date();
  const days = ["日", "一", "二", "三", "四", "五", "六"];
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return { dateStr: `${y}-${mo}-${d}`, weekday: `周${days[now.getDay()]}` };
}

// ─── 报告构建 ────────────────────────────────────────────────────────────────

function buildReport(todayItems, overdueItems) {
  const { dateStr, weekday } = todayWeekday();
  const lines = [`📋 今日提醒事项 | ${dateStr}（${weekday}）`, ""];

  // 逾期未完成（最重要，放最前面）
  const overduePending = overdueItems.filter((r) => !r.isCompleted);
  if (overduePending.length > 0) {
    lines.push(`⚠️ 逾期未完成（${overduePending.length} 条）：`);
    for (const r of overduePending) {
      lines.push(`  ☐ ${r.title}`);
      if (r.listName) lines.push(`    📂 ${r.listName}`);
    }
    lines.push("");
  }

  // 今日待办（未完成）
  const todayPending = todayItems.filter((r) => !r.isCompleted);
  const todayDone = todayItems.filter((r) => r.isCompleted);

  if (todayPending.length === 0 && overduePending.length === 0) {
    lines.push("✅ 今日无待办事项，尽情享受！");
  } else if (todayPending.length > 0) {
    lines.push(`📌 今日待办（${todayPending.length} 条）：`);
    for (const r of todayPending) {
      const time = formatDue(r.dueDate);
      const timeStr = time ? ` · ${time}` : "";
      lines.push(`  ☐ ${r.title}${timeStr}`);
      if (r.listName) lines.push(`    📂 ${r.listName}`);
    }
    lines.push("");
  }

  // 今日已完成（鼓励一下）
  if (todayDone.length > 0) {
    lines.push(`✅ 已完成（${todayDone.length} 条）：`);
    for (const r of todayDone) {
      lines.push(`  ☑ ${r.title}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("JPClaw 提醒播报 · 自动生成");

  return lines.join("\n");
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

export async function run(input) {
  const params = typeof input === "string"
    ? (input.trim() ? JSON.parse(input) : {})
    : (input || {});

  const {
    channelId = DEFAULT_CHANNEL_ID,
    telegramChatId = DEFAULT_TELEGRAM_ID,
    dmworkChannelId = process.env.DMWORK_DEFAULT_CHANNEL_ID || "",
  } = params;

  // 并行拉取今日 + 逾期事项
  const [todayResult, overdueResult] = await Promise.allSettled([
    rcJSON("today"),
    rcJSON("overdue"),
  ]);

  const todayItems = todayResult.status === "fulfilled" ? todayResult.value : [];
  const overdueItems = overdueResult.status === "fulfilled" ? overdueResult.value : [];

  // 去重：逾期中可能和今日重叠
  const overdueIds = new Set(overdueItems.map((r) => r.id ?? r.title));
  const todayOnly = todayItems.filter((r) => !overdueIds.has(r.id ?? r.title));

  const report = buildReport(todayOnly, overdueItems);

  // 并行推送
  const [discordResult, telegramResult, dmworkResult] = await Promise.allSettled([
    sendToDiscord(channelId, report),
    telegramChatId  ? sendToTelegram(telegramChatId, report)        : Promise.resolve([]),
    dmworkChannelId ? sendToDmwork(dmworkChannelId, report, 2)      : Promise.resolve(null),
  ]);

  return JSON.stringify({
    ok: true,
    todayCount: todayItems.filter((r) => !r.isCompleted).length,
    overdueCount: overdueItems.filter((r) => !r.isCompleted).length,
    discord: discordResult.status === "fulfilled" ? discordResult.value : `error: ${discordResult.reason}`,
    telegram: telegramResult.status === "fulfilled" ? telegramResult.value : `error: ${telegramResult.reason}`,
    dmwork: dmworkResult.status === "fulfilled" ? "ok" : `error: ${dmworkResult.reason}`,
  });
}

export default run;
