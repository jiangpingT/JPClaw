/** 迁移自 tests/js/memory-writer.spec.ts → Vitest 统一框架 */
import { describe, it, expect } from 'vitest';
import fs from "node:fs";
import path from "node:path";
import { writeMemoryFromUserInput } from "../../src/js/memory/writer.js";
import { memoryFile } from "../../src/js/memory/store.js";

describe('memory-writer', () => {
  it("should writeMemoryFromUserInput persists pinned/profile into hashed json and md files", () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), "sessions", "memtest-"));
    try {
      const userId = "1351911386602672133";
      const input = [
        "请你帮我记忆下来：",
        "使命：把可信智能带给身边的人",
        "使命：我姜平，是可信的践行者，我把可信智能带给身边的人",
        "合一模型：可信*智能",
        "天赋：好胜坚韧—真诚热情",
        "一件事：专注",
        "具体操作：专注在使命的达成"
      ].join("\n");

      const result = writeMemoryFromUserInput({
        memoryDir: dir,
        userId,
        userName: "jiangpingT",
        input,
        mode: "explicit"
      });
      expect(result.wrote).toBe(true);

      const file = memoryFile(dir, userId);
      expect(fs.existsSync(file)).toBeTruthy();
      const json = JSON.parse(fs.readFileSync(file, "utf-8")) as any;
      expect(json.userId).toBe(userId);
      expect(json.userName).toBe("jiangpingT");
      expect(json.profile).toBeTruthy();
      expect(json.profile.missionShort).toBe("把可信智能带给身边的人");
      expect(json.profile.model).toBe("可信*智能");
      expect(json.profile.oneThing).toBe("专注");

      // Daily and long-term md should be appended when "记住" is present.
      const rootHash = path.basename(file).replace(/^u_/, "").replace(/\.json$/, "");
      const root = path.join(dir, `u_${rootHash}`);
      const today = new Date().toISOString().slice(0, 10);
      const daily = path.join(root, "daily", `${today}.md`);
      expect(fs.existsSync(daily)).toBeTruthy();
      const dailyText = fs.readFileSync(daily, "utf-8");
      expect(dailyText.includes("[profile] 使命(短): 把可信智能带给身边的人")).toBeTruthy();

      const mem = path.join(root, "MEMORY.md");
      expect(fs.existsSync(mem)).toBeTruthy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
