import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadUserMemory, saveUserMemory, type UserMemory } from "./store.js";
import { recordMetric } from "../shared/metrics.js";

export type Bm25Hit = { content: string; score: number };

type Task<T> = () => Promise<T>;
const sqliteQueueByUserId = new Map<string, Promise<unknown>>();

function enqueueUserSqlite<T>(userId: string, task: Task<T>): Promise<T> {
  const key = String(userId || "unknown");
  const prev = sqliteQueueByUserId.get(key) || Promise.resolve();
  const run = prev.then(task, task);
  sqliteQueueByUserId.set(key, run.then(() => undefined, () => undefined));
  return run;
}

function isCjkChar(ch: string): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0) || 0;
  // Basic CJK Unified Ideographs + Extension A.
  return (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff);
}

function normalizeForFts(input: string): string {
  const text = String(input || "").trim();
  if (!text) return "";

  // Make Chinese searchable by substrings using overlapping bigrams, while keeping
  // ASCII words/numbers searchable as normal tokens.
  const tokens: string[] = [];
  let cjkRun: string[] = [];
  let asciiRun = "";

  const flushAscii = () => {
    const t = asciiRun.trim();
    if (t) tokens.push(t);
    asciiRun = "";
  };

  const flushCjk = () => {
    if (cjkRun.length === 0) return;
    if (cjkRun.length === 1) {
      tokens.push(cjkRun[0]);
      cjkRun = [];
      return;
    }
    for (let i = 0; i < cjkRun.length - 1; i++) {
      tokens.push(cjkRun[i] + cjkRun[i + 1]);
    }
    cjkRun = [];
  };

  for (const ch of Array.from(text)) {
    if (isCjkChar(ch)) {
      flushAscii();
      cjkRun.push(ch);
      continue;
    }
    flushCjk();
    // Collapse all non-word-ish characters to spaces to avoid odd MATCH parsing.
    if (/[a-zA-Z0-9]/.test(ch)) {
      asciiRun += ch;
    } else {
      flushAscii();
    }
  }
  flushAscii();
  flushCjk();
  return tokens.join(" ");
}

function sqlite3Bin(): string {
  return (process.env.JPCLAW_SQLITE3_BIN || "sqlite3").trim() || "sqlite3";
}

function dbPath(): string {
  const raw = process.env.JPCLAW_BM25_DB_PATH;
  if (raw && raw.trim()) return path.resolve(process.cwd(), raw.trim());
  return path.resolve(process.cwd(), "sessions", "memory", "bm25.sqlite");
}

function enabled(): boolean {
  const raw = process.env.JPCLAW_BM25_ENABLED;
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function maxQueryMs(): number {
  const raw = process.env.JPCLAW_BM25_QUERY_TIMEOUT_MS;
  const ms = Number(raw || "200");
  return Number.isFinite(ms) ? Math.max(50, ms) : 200;
}

function maxIndexMs(): number {
  const raw = process.env.JPCLAW_BM25_INDEX_TIMEOUT_MS;
  const ms = Number(raw || "500");
  return Number.isFinite(ms) ? Math.max(100, ms) : 500;
}

function escapeSqlString(text: string): string {
  return text.replace(/'/g, "''");
}

async function runSqlAsync(
  sql: string,
  timeoutMs: number
): Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean }> {
  const db = dbPath();
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const bin = sqlite3Bin();

  return await new Promise((resolve) => {
    const child = spawn(bin, ["-batch", "-noheader", db], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let done = false;
    let timedOut = false;

    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve({ ok, stdout, stderr, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish(false);
    }, timeoutMs);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      stderr += String(err);
      finish(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });

    try {
      child.stdin.write(sql, "utf-8");
      child.stdin.end();
    } catch (err) {
      clearTimeout(timer);
      stderr += String(err);
      finish(false);
    }
  });
}

async function ensureSchemaAsync(): Promise<boolean> {
  const sql = [
    "PRAGMA journal_mode=WAL;",
    "PRAGMA synchronous=NORMAL;",
    // FTS5 is the only place we rely on SQLite features; if it's missing, we degrade gracefully.
    "CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(userId, kind, content, content_raw UNINDEXED, updatedAt UNINDEXED, tokenize='unicode61');"
  ].join("\n");
  const res = await runSqlAsync(sql, maxIndexMs());
  if (!res.ok) return false;

  // If we previously created mem_fts without the raw column, recreate it (small DB, ok to rebuild).
  const colCheck = await runSqlAsync(
    "SELECT 1 FROM pragma_table_info('mem_fts') WHERE name='content_raw' LIMIT 1;",
    maxIndexMs()
  );
  if (colCheck.ok && colCheck.stdout.trim() === "1") return true;

  const rebuild = await runSqlAsync(
    [
      "DROP TABLE IF EXISTS mem_fts;",
      "CREATE VIRTUAL TABLE mem_fts USING fts5(userId, kind, content, content_raw UNINDEXED, updatedAt UNINDEXED, tokenize='unicode61');"
    ].join("\n"),
    maxIndexMs()
  );
  return rebuild.ok;
}

function flattenForIndex(memory: UserMemory): Array<{ kind: string; content: string }> {
  const docs: Array<{ kind: string; content: string }> = [];
  const profile = memory.profile || ({} as any);
  const push = (kind: string, line: string | undefined) => {
    const t = String(line || "").trim();
    if (!t) return;
    docs.push({ kind, content: t });
  };

  push("profile", profile.missionShort ? `使命(短): ${profile.missionShort}` : "");
  push("profile", profile.missionFull ? `使命(全): ${profile.missionFull}` : "");
  push("profile", profile.vision ? `愿景: ${profile.vision}` : "");
  push("profile", profile.model ? `合一模型: ${profile.model}` : "");
  push("profile", profile.talent ? `天赋: ${profile.talent}` : "");
  push("profile", profile.huiTalent ? `辉哥天赋: ${profile.huiTalent}` : "");
  push("profile", profile.oneThing ? `一件事: ${profile.oneThing}` : "");
  push("profile", profile.operation ? `具体操作: ${profile.operation}` : "");
  if (Array.isArray(profile.values) && profile.values.length) {
    push("profile", `价值观: ${profile.values.join(", ")}`);
  }
  push("profile", profile.responseStyle ? `回答风格偏好: ${profile.responseStyle}` : "");

  for (const item of memory.pinnedNotes || []) push("pinned", item);
  for (const item of memory.longTerm || []) push("fact", item);
  return docs;
}

function shouldReindex(memory: UserMemory): boolean {
  const minIntervalMs = Number(process.env.JPCLAW_BM25_INDEX_MIN_INTERVAL_MS || "30000");
  const last = memory.lastBm25IndexAt ? Date.parse(memory.lastBm25IndexAt) : 0;
  if (!last) return true;
  return Date.now() - last >= minIntervalMs;
}

export async function ensureBm25IndexedForUser(options: {
  memoryDir: string;
  userId: string;
  userName?: string;
}): Promise<{ ok: boolean; reason?: string }> {
  return await enqueueUserSqlite(options.userId, async () => {
  const startedAt = Date.now();
  if (!enabled()) return { ok: false, reason: "disabled" };
  if (!(await ensureSchemaAsync())) return { ok: false, reason: "schema_failed" };

  const memory = loadUserMemory(options.memoryDir, options.userId, options.userName);
  if (!shouldReindex(memory)) return { ok: true };

  const docs = flattenForIndex(memory);
  const parts: string[] = [];
  parts.push(`DELETE FROM mem_fts WHERE userId='${escapeSqlString(options.userId)}';`);
  for (const d of docs) {
    const raw = String(d.content || "").trim();
    const normalized = normalizeForFts(raw) || raw;
    parts.push(
      "INSERT INTO mem_fts(userId, kind, content, content_raw, updatedAt) VALUES(" +
        `'${escapeSqlString(options.userId)}',` +
        `'${escapeSqlString(d.kind)}',` +
        `'${escapeSqlString(normalized)}',` +
        `'${escapeSqlString(raw)}',` +
        `'${escapeSqlString(memory.updatedAt || new Date().toISOString())}'` +
        ");"
    );
  }

  const res = await runSqlAsync(parts.join("\n"), maxIndexMs());
  if (!res.ok) {
    recordMetric("bm25.index", {
      ok: false,
      durationMs: Date.now() - startedAt,
      meta: { timedOut: res.timedOut, reason: res.timedOut ? "timeout" : "failed" }
    });
    if (res.timedOut) return { ok: false, reason: "index_timeout" };
    return { ok: false, reason: "index_failed" };
  }

  memory.lastBm25IndexAt = new Date().toISOString();
  saveUserMemory(options.memoryDir, memory);
  recordMetric("bm25.index", { ok: true, durationMs: Date.now() - startedAt });
  return { ok: true };
  });
}

export async function queryBm25(options: {
  memoryDir: string;
  userId: string;
  userName?: string;
  query: string;
  limit: number;
}): Promise<{ ok: boolean; hits: Bm25Hit[]; reason?: string }> {
  const startedAt = Date.now();
  if (!enabled()) return { ok: false, hits: [], reason: "disabled" };
  const indexed = await ensureBm25IndexedForUser({
    memoryDir: options.memoryDir,
    userId: options.userId,
    userName: options.userName
  });
  if (!indexed.ok) return { ok: false, hits: [], reason: indexed.reason };

  const q = options.query.trim();
  if (!q) return { ok: true, hits: [] };
  const normQ = normalizeForFts(q);
  if (!normQ) return { ok: true, hits: [] };

  const sql = [
    ".mode list",
    ".separator \\t",
    "SELECT content_raw, (0.0 - bm25(mem_fts)) AS score",
    "FROM mem_fts",
    `WHERE userId='${escapeSqlString(options.userId)}' AND mem_fts MATCH '${escapeSqlString(normQ)}'`,
    `ORDER BY bm25(mem_fts) ASC LIMIT ${Math.max(1, Math.min(50, options.limit))};`
  ].join("\n");
  const res = await runSqlAsync(sql, maxQueryMs());
  if (!res.ok) {
    recordMetric("bm25.query", {
      ok: false,
      durationMs: Date.now() - startedAt,
      meta: { timedOut: res.timedOut, reason: res.timedOut ? "timeout" : "failed" }
    });
    if (res.timedOut) return { ok: false, hits: [], reason: "query_timeout" };
    return { ok: false, hits: [], reason: "query_failed" };
  }

  const hits: Bm25Hit[] = [];
  for (const line of res.stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const [content, scoreRaw] = t.split("\t");
    const score = Number(scoreRaw || "0");
    hits.push({ content: (content || "").trim(), score: Number.isFinite(score) ? score : 0 });
  }
  recordMetric("bm25.query", { ok: true, durationMs: Date.now() - startedAt, meta: { hits: hits.length } });
  return { ok: true, hits };
}
