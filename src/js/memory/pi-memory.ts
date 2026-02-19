import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fuseHeuristicAndBm25, scoreItemsForRetrieval, selectRelevantItems } from "./retrieval.js";
import { queryBm25 } from "./bm25-sqlite.js";
import type { Bm25Hit } from "./bm25-sqlite.js";

type StructuredProfile = {
  missionShort?: string;
  missionFull?: string;
  vision?: string;
  model?: string;
  talent?: string;
  huiTalent?: string;
  oneThing?: string;
  operation?: string;
  values?: string[];
  responseStyle?: string;
  updatedAt?: string;
};

type UserMemory = {
  userId: string;
  userName?: string;
  longTerm?: string[];
  pinnedNotes?: string[];
  profile?: StructuredProfile;
};

function hashUserId(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 24);
}

function memoryFile(memoryDir: string, userId: string): string {
  return path.join(memoryDir, `u_${hashUserId(userId)}.json`);
}

function userMemoryRoot(memoryDir: string, userId: string): string {
  return path.join(memoryDir, `u_${hashUserId(userId)}`);
}

function userDailyMemoryFile(root: string, date: Date): string {
  const stamp = date.toISOString().slice(0, 10);
  return path.join(root, "daily", `${stamp}.md`);
}

function userLongTermMemoryFile(root: string): string {
  return path.join(root, "MEMORY.md");
}

function readMemoryFileLines(file: string, maxLines: number): string[] {
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, "utf-8");
  const lines = content
    .split("\n")
    .map((x) => x.trim())
    .filter((x) => x.startsWith("- "))
    .map((x) => x.replace(/^- /, ""));
  if (lines.length <= maxLines) return lines;
  return lines.slice(-maxLines);
}

function buildProfileLines(profile: StructuredProfile | undefined): string[] {
  const p = profile || {};
  const lines: string[] = [];
  if (p.missionShort) lines.push(`使命(简): ${p.missionShort}`);
  if (p.missionFull) lines.push(`使命(全): ${p.missionFull}`);
  if (p.vision) lines.push(`愿景: ${p.vision}`);
  if (p.model) lines.push(`合一模型: ${p.model}`);
  if (p.talent) lines.push(`天赋: ${p.talent}`);
  if (p.huiTalent) lines.push(`辉哥天赋: ${p.huiTalent}`);
  if (p.oneThing) lines.push(`一件事: ${p.oneThing}`);
  if (p.operation) lines.push(`具体操作: ${p.operation}`);
  if (Array.isArray(p.values) && p.values.length) lines.push(`价值观: ${p.values.join(", ")}`);
  if (p.responseStyle) lines.push(`回答风格偏好: ${p.responseStyle}`);
  return lines;
}

export async function computePiBm25Hits(options: {
  memoryDir: string;
  userId: string;
  userName?: string;
  query: string;
  isOwner: boolean;
}): Promise<Bm25Hit[]> {
  const res = await queryBm25({
    memoryDir: options.memoryDir,
    userId: options.userId,
    userName: options.userName,
    query: options.query,
    limit: options.isOwner ? 10 : 6
  });
  if (!res.ok) return [];
  return res.hits.filter((h) => String(h.content || "").trim());
}

export function buildPiMemorySnippet(options: {
  memoryDir: string;
  userId: string;
  userName?: string;
  input: string;
  // Owner gets a slightly larger snippet by default.
  isOwner: boolean;
  // Optional: precomputed BM25 hits (async cached).
  bm25Hits?: Bm25Hit[];
}): string {
  const file = memoryFile(options.memoryDir, options.userId);
  if (!fs.existsSync(file)) return "";

  let memory: UserMemory;
  try {
    memory = JSON.parse(fs.readFileSync(file, "utf-8")) as UserMemory;
  } catch {
    return "";
  }

  const profileLines = buildProfileLines(memory.profile);
  const longTerm = Array.isArray(memory.longTerm) ? memory.longTerm : [];
  const pinned = Array.isArray(memory.pinnedNotes) ? memory.pinnedNotes : [];
  const pool = [...pinned, ...longTerm];
  const limit = options.isOwner ? 10 : 6;
  const heurScored = scoreItemsForRetrieval(options.input, pool);
  const bm25Hits = Array.isArray(options.bm25Hits) ? options.bm25Hits : [];

  // True 70/30 fusion: heuristic understands "intent" better, BM25 helps precise keyword hits.
  const heuristicWeight = Number(process.env.JPCLAW_RETRIEVAL_HEURISTIC_WEIGHT || "0.7");
  const bm25Weight = Number(process.env.JPCLAW_RETRIEVAL_BM25_WEIGHT || "0.3");
  const relevant = fuseHeuristicAndBm25({
    heuristic: heurScored,
    bm25Hits,
    heuristicWeight: Number.isFinite(heuristicWeight) ? heuristicWeight : 0.7,
    bm25Weight: Number.isFinite(bm25Weight) ? bm25Weight : 0.3,
    pinned: new Set(pinned),
    limit
  });

  const fileHints: string[] = [];
  // Optional: align with md-based memory store (daily/MEMORY.md).
  const root = userMemoryRoot(options.memoryDir, options.userId);
  const today = userDailyMemoryFile(root, new Date());
  const yesterday = userDailyMemoryFile(root, new Date(Date.now() - 24 * 60 * 60 * 1000));
  const dailyRaw = [...readMemoryFileLines(today, 10), ...readMemoryFileLines(yesterday, 8)];
  const longRaw = options.isOwner ? readMemoryFileLines(userLongTermMemoryFile(root), 16) : [];
  for (const line of [...dailyRaw, ...longRaw]) {
    const cleaned = line.replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+/, "").trim();
    if (cleaned) fileHints.push(cleaned);
  }
  const relevantFiles = selectRelevantItems(options.input, fileHints, options.isOwner ? 10 : 6);

  if (profileLines.length === 0 && relevant.length === 0 && relevantFiles.length === 0) return "";

  const lines: string[] = [];
  lines.push("【用户长期记忆（来自本地 memory store，需优先遵守）】");
  if (options.userName) lines.push(`用户昵称: ${options.userName}`);
  if (profileLines.length) {
    lines.push("用户画像:");
    for (const l of profileLines) lines.push(`- ${l}`);
  }
  if (relevant.length) {
    lines.push("相关长期事实/备注:");
    for (const l of relevant) lines.push(`- ${l}`);
  }
  if (relevantFiles.length) {
    lines.push("相关记忆文件摘录:");
    for (const l of relevantFiles) lines.push(`- ${l}`);
  }
  lines.push("要求: 当用户问到画像/使命/愿景/价值观时，直接引用以上信息回答，不要说“不知道/未提供”。");
  return lines.join("\n");
}
