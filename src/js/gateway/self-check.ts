import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { log } from "../shared/logger.js";
import { resolvePromptsDir } from "../shared/prompt-files.js";

async function hasSqlite3(timeoutMs = 200): Promise<boolean> {
  const bin = (process.env.JPCLAW_SQLITE3_BIN || "sqlite3").trim() || "sqlite3";
  return await new Promise((resolve) => {
    const child = spawn(bin, ["-version"], { stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve(false);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function canCreateFts5Schema(timeoutMs = 300): Promise<boolean> {
  const bin = (process.env.JPCLAW_SQLITE3_BIN || "sqlite3").trim() || "sqlite3";
  const db = path.resolve(process.cwd(), "sessions", "memory", "selfcheck.sqlite");
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const sql = [
    "CREATE VIRTUAL TABLE IF NOT EXISTS self_fts USING fts5(content, tokenize='unicode61');",
    "INSERT INTO self_fts(content) VALUES('ok');",
    "SELECT count(*) FROM self_fts;"
  ].join("\n");
  return await new Promise((resolve) => {
    const child = spawn(bin, ["-batch", "-noheader", db], { stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve(false);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    try {
      child.stdin.write(sql, "utf-8");
      child.stdin.end();
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

function checkMemoryWritable(): boolean {
  const dir = path.resolve(process.cwd(), "sessions", "memory", "users");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe_${Date.now()}.txt`);
    fs.writeFileSync(probe, "ok", "utf-8");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function checkPromptsReadable(): { ok: boolean; missing: string[]; dir: string } {
  const dir = resolvePromptsDir();
  const required = ["IDENTITY.md", "SOUL.md", "AGENTS.md", "USER_DEFAULT.md"];
  const missing: string[] = [];
  for (const file of required) {
    const full = path.join(dir, file);
    try {
      if (!fs.existsSync(full)) missing.push(file);
    } catch {
      missing.push(file);
    }
  }
  return { ok: missing.length === 0, missing, dir };
}

export async function runGatewaySelfCheck(): Promise<void> {
  const prompts = checkPromptsReadable();
  if (!prompts.ok) {
    log("warn", "selfcheck.prompts.missing", { dir: prompts.dir, missing: prompts.missing });
  }

  if (!checkMemoryWritable()) {
    process.env.JPCLAW_MEMORY_WRITES_DISABLED = "true";
    log("error", "selfcheck.memory.not_writable", { dir: path.resolve(process.cwd(), "sessions", "memory", "users") });
  }

  const sqliteOk = await hasSqlite3();
  if (!sqliteOk) {
    process.env.JPCLAW_BM25_ENABLED = "false";
    log("warn", "selfcheck.sqlite3.missing", {});
    return;
  }

  const ftsOk = await canCreateFts5Schema();
  if (!ftsOk) {
    process.env.JPCLAW_BM25_ENABLED = "false";
    log("warn", "selfcheck.sqlite3.fts5_unavailable", {});
  }
}

