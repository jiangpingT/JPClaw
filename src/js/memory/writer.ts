import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  extractPinnedNotes,
  extractProfileFromText,
  mergeProfile,
  profileHasSignals,
  type StructuredProfile
} from "./extract.js";
import { extractFacts } from "./facts.js";
import { loadUserMemory, saveUserMemory, type UserMemory } from "./store.js";

export type MemoryWriteMode = "implicit" | "explicit";

function hashUserId(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 24);
}

function hashLine(line: string): string {
  return createHash("sha256").update(line).digest("hex").slice(0, 24);
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

function mergeLongTermFacts(existing: string[], incoming: string[]): string[] {
  if (incoming.length === 0) return existing;
  const map = new Map<string, string>();
  for (const fact of existing) {
    const key = normalizeFactKey(fact);
    map.set(key, fact);
  }
  for (const fact of incoming) {
    const key = normalizeFactKey(fact);
    map.set(key, fact);
  }
  return Array.from(map.values());
}

function normalizeFactKey(fact: string): string {
  const idx = fact.indexOf(":");
  if (idx === -1) return fact.trim();
  return fact.slice(0, idx).trim();
}

function parseFactLine(line: string): { key: string; value: string } | null {
  const idx = line.indexOf(":");
  if (idx === -1) return null;
  const key = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).trim();
  if (!key || !value) return null;
  return { key, value };
}

function buildFactMap(items: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    const parsed = parseFactLine(item);
    if (!parsed) continue;
    map.set(parsed.key, parsed.value);
  }
  return map;
}

function shouldAllowOverwrite(existing: string | undefined, incoming: string, isExplicit: boolean): boolean {
  if (isExplicit) return true;
  if (!existing) return true;
  return existing === incoming;
}

function shouldPromoteToLongTerm(
  facts: string[],
  pinned: string[],
  profileDelta: StructuredProfile
): boolean {
  if (pinned.length > 0) return true;
  if (profileHasSignals(profileDelta)) return true;
  return facts.some((fact) => /姓名|称呼|身份|位置|偏好|语言|格式/.test(fact));
}

function diffProfileKeys(prev: StructuredProfile, next: StructuredProfile): string[] {
  const keys = new Set<string>([...Object.keys(prev || {}), ...Object.keys(next || {})]);
  const changed: string[] = [];
  for (const key of keys) {
    if (key === "updatedAt") continue;
    const a = (prev as any)?.[key];
    const b = (next as any)?.[key];
    if (Array.isArray(a) || Array.isArray(b)) {
      if (JSON.stringify(a || []) !== JSON.stringify(b || [])) changed.push(key);
      continue;
    }
    if ((a ?? undefined) !== (b ?? undefined)) changed.push(key);
  }
  return changed;
}

function buildStructuredProfileLines(profile: StructuredProfile): string[] {
  const lines: string[] = [];
  if (profile.missionShort) lines.push(`使命(短): ${profile.missionShort}`);
  if (profile.missionFull) lines.push(`使命(完整): ${profile.missionFull}`);
  if (profile.vision) lines.push(`愿景: ${profile.vision}`);
  if (profile.model) lines.push(`合一模型: ${profile.model}`);
  if (profile.talent) lines.push(`天赋: ${profile.talent}`);
  if (profile.huiTalent) lines.push(`辉哥天赋: ${profile.huiTalent}`);
  if (profile.oneThing) lines.push(`一件事: ${profile.oneThing}`);
  if (profile.operation) lines.push(`具体操作: ${profile.operation}`);
  if (profile.values && profile.values.length > 0) lines.push(`价值观: ${profile.values.join(" / ")}`);
  if (profile.responseStyle) lines.push(`回复风格: ${profile.responseStyle}`);
  return lines;
}

function buildMemoryLines(input: {
  facts: string[];
  pinned: string[];
  profileDelta: StructuredProfile;
  profileKeysChanged: string[];
}): string[] {
  const lines: string[] = [];
  for (const fact of input.facts) {
    lines.push(`[fact] ${fact}`);
  }
  for (const note of input.pinned) {
    lines.push(`[pinned] ${note}`);
  }
  const delta: StructuredProfile = {};
  for (const key of input.profileKeysChanged) {
    (delta as any)[key] = (input.profileDelta as any)?.[key];
  }
  const profileLines = buildStructuredProfileLines(delta);
  for (const item of profileLines) {
    lines.push(`[profile] ${item}`);
  }
  return lines;
}

function appendMemoryLines(file: string, lines: string[]): void {
  if (lines.length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  const content = lines.map((line) => `- ${stamp} ${line}`).join("\n") + "\n";
  fs.appendFileSync(file, content, "utf-8");
}

function appendMemoryLinesDedup(file: string, lines: string[], memory: UserMemory): number {
  if (lines.length === 0) return 0;
  if (!Array.isArray(memory.recentMdLineHashes)) memory.recentMdLineHashes = [];
  const recent = new Set<string>(memory.recentMdLineHashes);
  const unique: string[] = [];
  const addedHashes: string[] = [];
  const fileTag = path.basename(file);
  for (const line of lines) {
    const cleaned = String(line || "").trim();
    if (!cleaned) continue;
    // Dedup is per-file to avoid suppressing writes across daily vs MEMORY.md.
    const h = hashLine(`${fileTag}:${cleaned}`);
    if (recent.has(h)) continue;
    unique.push(cleaned);
    addedHashes.push(h);
  }
  if (unique.length === 0) return 0;
  appendMemoryLines(file, unique);
  memory.recentMdLineHashes = [...memory.recentMdLineHashes, ...addedHashes].slice(-200);
  return unique.length;
}

function ensureMemoryShape(memory: UserMemory): void {
  if (!Array.isArray(memory.shortTerm)) memory.shortTerm = [];
  if (!Array.isArray(memory.longTerm)) memory.longTerm = [];
  if (!Array.isArray(memory.pinnedNotes)) memory.pinnedNotes = [];
  if (typeof memory.midTerm !== "string") memory.midTerm = "";
  if (!memory.profile || typeof memory.profile !== "object") (memory as any).profile = {};
  if (typeof memory.schemaVersion !== "number") memory.schemaVersion = 2;
  if (typeof memory.updatedAt !== "string") memory.updatedAt = new Date().toISOString();
  if (!Array.isArray((memory as any).recentMdLineHashes)) (memory as any).recentMdLineHashes = [];
}

export function writeMemoryFromUserInput(options: {
  memoryDir: string;
  userId: string;
  userName?: string;
  input: string;
  mode?: MemoryWriteMode;
}): {
  wrote: boolean;
  factsAdded: number;
  pinnedAdded: number;
  profileUpdated: boolean;
  dailyFile?: string;
  longFile?: string;
  conflictsSkipped?: number;
} {
  if ((process.env.JPCLAW_MEMORY_WRITES_DISABLED || "").toLowerCase() === "true") {
    return { wrote: false, factsAdded: 0, pinnedAdded: 0, profileUpdated: false, conflictsSkipped: 0 };
  }
  const mode: MemoryWriteMode = options.mode || "implicit";
  const isExplicit =
    mode === "explicit" ||
    /请你帮我记忆下来|请记住|记住|长期记住|帮我记下来|写入长期记忆|永久记住/i.test(options.input);

  const memory = loadUserMemory(options.memoryDir, options.userId, options.userName);
  ensureMemoryShape(memory);

  const facts = extractFacts(options.input);
  const pinned = extractPinnedNotes(options.input);
  const profileDelta = extractProfileFromText(options.input);

  const beforeLongMap = buildFactMap(memory.longTerm || []);
  const beforePinnedSet = new Set(memory.pinnedNotes || []);
  const beforeProfileObj = { ...(memory.profile || {}) } as StructuredProfile;

  // Facts/profile can be updated implicitly, but we avoid bloat and accidental overwrites:
  // - Implicit: only add new keys; never overwrite existing keys with different values.
  // - Explicit: allow overwrite; conflicts are handled upstream when requested.
  const incomingFactMap = buildFactMap(facts);
  const changedFacts: string[] = [];
  let conflictsSkipped = 0;
  for (const [key, value] of incomingFactMap.entries()) {
    const prev = beforeLongMap.get(key);
    if (!prev) {
      changedFacts.push(`${key}: ${value}`);
      continue;
    }
    if (prev === value) continue;
    if (isExplicit) {
      changedFacts.push(`${key}: ${value}`);
      continue;
    }
    conflictsSkipped += 1;
  }

  // Apply profile delta with the same overwrite policy (implicit should not overwrite non-empty fields).
  const effectiveProfileDelta: StructuredProfile = {};
  for (const [k, v] of Object.entries(profileDelta || {})) {
    const key = k as keyof StructuredProfile;
    const incoming = v as any;
    if (incoming === undefined || incoming === null) continue;
    const prev = (beforeProfileObj as any)?.[key];
    if (Array.isArray(incoming)) {
      const prevArr = Array.isArray(prev) ? prev : [];
      if (JSON.stringify(prevArr) === JSON.stringify(incoming)) continue;
      if (!isExplicit && Array.isArray(prev) && prev.length > 0) continue;
      (effectiveProfileDelta as any)[key] = incoming;
      continue;
    }
    const nextStr = String(incoming);
    const prevStr = prev === undefined || prev === null ? "" : String(prev);
    if (prevStr && prevStr === nextStr) continue;
    if (!shouldAllowOverwrite(prevStr || undefined, nextStr, isExplicit)) continue;
    (effectiveProfileDelta as any)[key] = incoming;
  }
  mergeProfile(memory.profile, effectiveProfileDelta);

  const mergedFacts = mergeLongTermFacts(memory.longTerm, changedFacts);
  memory.longTerm = mergedFacts.slice(-40);

  const newPinned: string[] = [];
  if (isExplicit) {
    for (const note of pinned) {
      if (!beforePinnedSet.has(note)) newPinned.push(note);
    }
  }
  const pinnedSet = new Set(memory.pinnedNotes || []);
  for (const note of newPinned) pinnedSet.add(note);
  memory.pinnedNotes = Array.from(pinnedSet).slice(-24);

  const profileKeysChanged = diffProfileKeys(beforeProfileObj, memory.profile || {});

  const factsAdded = changedFacts.length;
  const pinnedAdded = newPinned.length;
  const profileUpdated = profileKeysChanged.length > 0;

  const wrote = changedFacts.length > 0 || newPinned.length > 0 || profileUpdated;
  if (!wrote) {
    return { wrote: false, factsAdded: 0, pinnedAdded: 0, profileUpdated: false, conflictsSkipped };
  }

  const lines = buildMemoryLines({
    facts: changedFacts,
    pinned: newPinned,
    profileDelta: memory.profile || ({} as StructuredProfile),
    profileKeysChanged
  });
  const root = userMemoryRoot(options.memoryDir, memory.userId);

  let longFile: string | undefined;
  let dailyFile: string | undefined;
  const minIntervalMs = Number(process.env.JPCLAW_IMPLICIT_MD_MIN_INTERVAL_MS || "60000");
  const lastMd = memory.lastMdWriteAt ? Date.parse(memory.lastMdWriteAt) : 0;
  const allowMdAppend = isExplicit || !lastMd || Date.now() - lastMd >= minIntervalMs;
  if (lines.length > 0 && allowMdAppend) {
    dailyFile = userDailyMemoryFile(root, new Date());
    const appended = appendMemoryLinesDedup(dailyFile, lines, memory);
    memory.lastMdWriteAt = new Date().toISOString();
    if (appended === 0) {
      // Avoid bumping updatedAt when we didn't actually write anything new.
      dailyFile = undefined;
    }
  }
  // Long-term md (MEMORY.md) only on explicit memory writes to avoid unbounded growth.
  if (isExplicit && lines.length > 0 && shouldPromoteToLongTerm(changedFacts, newPinned, profileDelta as StructuredProfile)) {
    longFile = userLongTermMemoryFile(root);
    appendMemoryLinesDedup(longFile, lines, memory);
  }

  memory.updatedAt = new Date().toISOString();
  saveUserMemory(options.memoryDir, memory);
  return { wrote: true, factsAdded, pinnedAdded, profileUpdated, dailyFile, longFile, conflictsSkipped };
}
