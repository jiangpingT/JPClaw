import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type DiscordFeedbackEvent = {
  time: string;
  userId: string;
  channelId: string;
  kind: "reaction" | "reply";
  value: string;
  messageId?: string;
};

const FEEDBACK_FILE = path.resolve(process.cwd(), "sessions", "feedback", "discord-feedback.jsonl");
const CACHE_TTL_MS = 30_000;

const POSITIVE_REACTIONS = new Set(["👍", "❤️", "🔥", "✅", "😄", "🎉", "👏", "100"]);
const NEGATIVE_REACTIONS = new Set(["👎", "❌", "😡", "🤮", "💀"]);

let cache:
  | {
      expiresAt: number;
      byUser: Map<string, DiscordFeedbackEvent[]>;
    }
  | undefined;

function ensureDir(): void {
  mkdirSync(path.dirname(FEEDBACK_FILE), { recursive: true });
}

function normalizeUserKeys(userId: string): string[] {
  const raw = String(userId || "").trim();
  if (!raw) return [];
  const out = [raw];
  const parts = raw.split("::");
  if (parts.length > 1) {
    const last = parts[parts.length - 1]?.trim();
    if (last && !out.includes(last)) out.push(last);
  }
  return out;
}

export function appendDiscordFeedback(event: Omit<DiscordFeedbackEvent, "time">): void {
  const record: DiscordFeedbackEvent = {
    ...event,
    time: new Date().toISOString()
  };
  try {
    ensureDir();
    appendFileSync(FEEDBACK_FILE, `${JSON.stringify(record)}\n`);
    cache = undefined;
  } catch {
    // non-fatal
  }
}

function loadFeedbackIndex(): Map<string, DiscordFeedbackEvent[]> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.byUser;
  }
  const byUser = new Map<string, DiscordFeedbackEvent[]>();
  if (!existsSync(FEEDBACK_FILE)) {
    cache = { expiresAt: Date.now() + CACHE_TTL_MS, byUser };
    return byUser;
  }
  const raw = readFileSync(FEEDBACK_FILE, "utf-8");
  const lines = raw.split("\n").map((x) => x.trim()).filter(Boolean);
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as DiscordFeedbackEvent;
      if (!event?.userId) continue;
      const list = byUser.get(event.userId) || [];
      list.push(event);
      byUser.set(event.userId, list);
    } catch {
      // skip
    }
  }
  cache = { expiresAt: Date.now() + CACHE_TTL_MS, byUser };
  return byUser;
}

function reactionScore(value: string): number {
  if (POSITIVE_REACTIONS.has(value)) return 1;
  if (NEGATIVE_REACTIONS.has(value)) return -1;
  return 0;
}

function replySignals(text: string): { positive: number; negative: number; concise: number } {
  const t = text.toLowerCase();
  let positive = 0;
  let negative = 0;
  let concise = 0;
  if (/(很好|不错|赞|清楚|有用|牛|满意|喜欢|谢谢|可以)/.test(t)) positive += 1;
  if (/(太长|啰嗦|跑偏|不对|不行|卡住|没回复|失败|慢)/.test(t)) negative += 1;
  if (/(简短|精简|一句话|先结论|先给结果)/.test(t)) concise += 1;
  return { positive, negative, concise };
}

export function buildDiscordFeedbackSnippet(userId: string): string {
  const keys = normalizeUserKeys(userId);
  if (keys.length === 0) return "";

  const index = loadFeedbackIndex();
  const events: DiscordFeedbackEvent[] = [];
  for (const k of keys) {
    const list = index.get(k);
    if (list?.length) events.push(...list);
  }
  if (events.length === 0) return "";

  const recent = events
    .filter((e) => Date.now() - Date.parse(e.time || "0") <= 14 * 24 * 3600 * 1000)
    .slice(-200);
  if (recent.length === 0) return "";

  let reactionUp = 0;
  let reactionDown = 0;
  let replyPos = 0;
  let replyNeg = 0;
  let preferConcise = 0;

  for (const e of recent) {
    if (e.kind === "reaction") {
      const score = reactionScore(e.value);
      if (score > 0) reactionUp += 1;
      if (score < 0) reactionDown += 1;
      continue;
    }
    if (e.kind === "reply") {
      const s = replySignals(e.value);
      replyPos += s.positive;
      replyNeg += s.negative;
      preferConcise += s.concise;
    }
  }

  const lines: string[] = [];
  lines.push("反馈偏好（近14天，来自 Discord 互动）：");
  lines.push(`- 正向反馈: ${reactionUp + replyPos}`);
  lines.push(`- 负向反馈: ${reactionDown + replyNeg}`);
  if (preferConcise > 0) {
    lines.push("- 风格偏好: 先给结论，避免冗长。");
  }
  if (reactionDown + replyNeg > reactionUp + replyPos) {
    lines.push("- 回答策略: 先确认任务边界，再给可执行结果。");
  }
  return lines.join("\n");
}

