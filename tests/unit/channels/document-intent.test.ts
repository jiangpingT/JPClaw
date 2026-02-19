/** 迁移自 tests/js/document-intent.spec.ts → Vitest 统一框架 */
import { describe, it, expect } from 'vitest';
import fs from "node:fs";
import path from "node:path";
import { extractFileRef, resolveFilePath } from "../../src/js/channels/document-intent.js";

describe('document-intent', () => {
  it("should extractFileRef supports quoted filename with spaces", () => {
    const input = '帮我阅读一下我电脑下载目录下的"Claude Code is the Inflection Point.pdf"，总结一下核心内容';
    expect(extractFileRef(input)).toBe("Claude Code is the Inflection Point.pdf");
  });

  it("should resolveFilePath can fuzzy-match suffix filename in common folders", () => {
    const downloads = path.join(process.env.HOME || "", "Downloads");
    const fileName = "JPClaw Test Document Name.pdf";
    const full = path.join(downloads, fileName);
    fs.mkdirSync(downloads, { recursive: true });
    fs.writeFileSync(full, "test", "utf-8");
    try {
      expect(resolveFilePath("Name.pdf")).toBe(full);
    } finally {
      fs.rmSync(full, { force: true });
    }
  });
});
