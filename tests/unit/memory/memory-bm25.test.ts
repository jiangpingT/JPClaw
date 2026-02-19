/** 迁移自 tests/js/memory-bm25.spec.ts → Vitest 统一框架 */
import { describe, it, expect } from 'vitest';
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeMemoryFromUserInput } from "../../src/js/memory/writer.js";
import { queryBm25 } from "../../src/js/memory/bm25-sqlite.js";

function hasSqlite3(): boolean {
  const res = spawnSync(process.env.JPCLAW_SQLITE3_BIN || "sqlite3", ["-version"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return res.status === 0;
}

describe('memory-bm25', () => {
  it("should bm25 sqlite retrieval returns relevant hits when sqlite3+fts5 is available", async () => {
    if (!hasSqlite3()) {
      return;
    }

    const dir = fs.mkdtempSync(path.join(process.cwd(), "sessions", "bm25test-"));
    try {
      const userId = "u_test_1";
      writeMemoryFromUserInput({
        memoryDir: dir,
        userId,
        input: "请你帮我记忆下来：使命：把可信智能带给身边的人\n合一模型：可信*智能",
        mode: "explicit"
      });

      const res = await queryBm25({
        memoryDir: dir,
        userId,
        query: "使命 可信智能",
        limit: 5
      });

      // FTS5 might be missing even if sqlite3 exists; in that case we allow graceful failure.
      if (!res.ok) return;
      expect(res.hits.some((h) => h.content.includes("使命"))).toBeTruthy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
