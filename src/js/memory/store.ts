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

export type UserMemory = {
  userId: string;
  userName?: string;
  shortTerm: Array<{ role: string; content: string }>;
  midTerm: string;
  longTerm: string[];
  pinnedNotes: string[];
  profile: StructuredProfile;
  schemaVersion: number;
  updatedAt: string;
  lastFlushAt?: string;
  lastMdWriteAt?: string;
  lastBm25IndexAt?: string;
  recentMdLineHashes?: string[];
};

function hashUserId(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 24);
}

export function memoryFile(memoryDir: string, userId: string): string {
  return path.join(memoryDir, `u_${hashUserId(userId)}.json`);
}

function legacyMemoryFile(memoryDir: string, userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(memoryDir, `${safe}.json`);
}

export function loadUserMemory(memoryDir: string, userId: string, userName?: string): UserMemory {
  fs.mkdirSync(memoryDir, { recursive: true });
  const file = memoryFile(memoryDir, userId);
  const legacyFile = legacyMemoryFile(memoryDir, userId);

  if (!fs.existsSync(file) && fs.existsSync(legacyFile)) {
    try {
      fs.renameSync(legacyFile, file);
    } catch {
      // Ignore; we'll just try reading legacy if rename fails.
    }
  }

  const readFrom = fs.existsSync(file) ? file : fs.existsSync(legacyFile) ? legacyFile : null;
  let loaded: Partial<UserMemory> = {};
  if (readFrom) {
    try {
      loaded = JSON.parse(fs.readFileSync(readFrom, "utf-8")) as Partial<UserMemory>;
    } catch {
      loaded = {};
    }
  }

  const now = new Date().toISOString();
  const memory: UserMemory = {
    userId,
    userName: userName || loaded.userName,
    shortTerm: Array.isArray(loaded.shortTerm) ? loaded.shortTerm : [],
    midTerm: typeof loaded.midTerm === "string" ? loaded.midTerm : "",
    longTerm: Array.isArray(loaded.longTerm) ? loaded.longTerm : [],
    pinnedNotes: Array.isArray(loaded.pinnedNotes) ? loaded.pinnedNotes : [],
    profile: (loaded.profile && typeof loaded.profile === "object" ? loaded.profile : {}) as StructuredProfile,
    schemaVersion: typeof loaded.schemaVersion === "number" ? loaded.schemaVersion : 2,
    updatedAt: typeof loaded.updatedAt === "string" ? loaded.updatedAt : now,
    lastFlushAt: typeof loaded.lastFlushAt === "string" ? loaded.lastFlushAt : undefined,
    lastMdWriteAt: typeof (loaded as any).lastMdWriteAt === "string" ? (loaded as any).lastMdWriteAt : undefined,
    lastBm25IndexAt: typeof (loaded as any).lastBm25IndexAt === "string" ? (loaded as any).lastBm25IndexAt : undefined,
    recentMdLineHashes: Array.isArray((loaded as any).recentMdLineHashes)
      ? ((loaded as any).recentMdLineHashes as unknown[]).map((x) => String(x)).filter(Boolean).slice(-200)
      : []
  };
  return memory;
}

export function saveUserMemory(memoryDir: string, memory: UserMemory): void {
  const file = memoryFile(memoryDir, memory.userId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(memory, null, 2));
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

export function applyUserMemoryUpdateFromText(options: {
  memoryDir: string;
  userId: string;
  userName?: string;
  input: string;
}): {
  saved: boolean;
  pinnedAdded: number;
  profileKeysUpdated: string[];
} {
  const memory = loadUserMemory(options.memoryDir, options.userId, options.userName);

  const pinned = extractPinnedNotes(options.input);
  const profileDelta = extractProfileFromText(options.input);

  const beforeProfile = { ...(memory.profile || {}) } as StructuredProfile;
  mergeProfile(memory.profile, profileDelta);

  const pinnedSet = new Set<string>(memory.pinnedNotes || []);
  const beforePinnedSize = pinnedSet.size;
  for (const note of pinned) pinnedSet.add(note);
  memory.pinnedNotes = Array.from(pinnedSet).slice(-24);

  const profileKeysUpdated = diffProfileKeys(beforeProfile, memory.profile || {});
  const pinnedAdded = Math.max(0, pinnedSet.size - beforePinnedSize);
  const shouldSave = pinnedAdded > 0 || profileHasSignals(profileDelta);
  if (!shouldSave) {
    return { saved: false, pinnedAdded: 0, profileKeysUpdated: [] };
  }

  memory.updatedAt = new Date().toISOString();
  saveUserMemory(options.memoryDir, memory);
  return { saved: true, pinnedAdded, profileKeysUpdated };
}
