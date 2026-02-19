/** 迁移自 tests/js/memory-denoise.spec.ts → Vitest 统一框架 */
import { describe, it, expect } from 'vitest';
import fs from "node:fs";
import path from "node:path";
import { writeMemoryFromUserInput } from "../../src/js/memory/writer.js";
import { loadUserMemory, memoryFile } from "../../src/js/memory/store.js";

function withEnv(vars: Record<string, string>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('memory-denoise', () => {
  it("should implicit memory writes are throttled and do not bloat md on repeats", () => {
    withEnv({ JPCLAW_IMPLICIT_MD_MIN_INTERVAL_MS: "999999" }, () => {
      const dir = fs.mkdtempSync(path.join(process.cwd(), "sessions", "memdenoise-"));
      try {
        const userId = "u_repeat_1";
        const input = "我叫姜平，你叫阿策。你以后回答我尽量都用中文。";

        const r1 = writeMemoryFromUserInput({ memoryDir: dir, userId, input, mode: "implicit" });
        expect(r1.wrote).toBe(true);

        const file = memoryFile(dir, userId);
        const rootHash = path.basename(file).replace(/^u_/, "").replace(/\.json$/, "");
        const today = new Date().toISOString().slice(0, 10);
        const daily = path.join(dir, `u_${rootHash}`, "daily", `${today}.md`);
        expect(fs.existsSync(daily)).toBeTruthy();
        const first = fs.readFileSync(daily, "utf-8");

        const r2 = writeMemoryFromUserInput({ memoryDir: dir, userId, input, mode: "implicit" });
        expect(r2.wrote).toBe(false);
        const second = fs.readFileSync(daily, "utf-8");
        expect(second).toBe(first);

        const mem = loadUserMemory(dir, userId);
        expect(mem.longTerm.some((x) => x.includes("用户姓名/称呼"))).toBeTruthy();
        expect(mem.profile.responseStyle?.includes("中文")).toBeTruthy();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("should implicit fact updates do not overwrite existing values; explicit can overwrite", () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), "sessions", "memdenoise-"));
    try {
      const userId = "u_conflict_1";
      const r1 = writeMemoryFromUserInput({ memoryDir: dir, userId, input: "我在北京", mode: "explicit" });
      expect(r1.wrote).toBe(true);
      const before = loadUserMemory(dir, userId);
      expect(before.longTerm.some((x) => x.includes("用户位置: 北京"))).toBeTruthy();

      const r2 = writeMemoryFromUserInput({ memoryDir: dir, userId, input: "我在上海", mode: "implicit" });
      expect(r2.wrote).toBe(false);
      const mid = loadUserMemory(dir, userId);
      expect(mid.longTerm.some((x) => x.includes("用户位置: 北京"))).toBeTruthy();
      expect(!mid.longTerm.some((x) => x.includes("用户位置: 上海"))).toBeTruthy();

      const r3 = writeMemoryFromUserInput({ memoryDir: dir, userId, input: "我在上海", mode: "explicit" });
      expect(r3.wrote).toBe(true);
      const after = loadUserMemory(dir, userId);
      expect(after.longTerm.some((x) => x.includes("用户位置: 上海"))).toBeTruthy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
