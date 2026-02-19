/** 迁移自 tests/js/intent-classifier.spec.ts → Vitest 统一框架 */
import { describe, it, expect } from 'vitest';
import { looksLikeCapabilityMetaQuestion } from "../../src/js/channels/intent-classifier.js";

describe('intent-classifier', () => {
  it("should capability meta question is detected without hard-coded full sentence", () => {
    expect(looksLikeCapabilityMetaQuestion("你的哪个 skill 对我最有用")).toBe(true);
    expect(looksLikeCapabilityMetaQuestion("你有哪些能力最适合我现在用")).toBe(true);
    expect(looksLikeCapabilityMetaQuestion("推荐几个你最擅长的技能")).toBe(true);
  });

  it("should local filesystem operations are not treated as capability questions", () => {
    expect(looksLikeCapabilityMetaQuestion("帮我查看下载目录")).toBe(false);
    expect(looksLikeCapabilityMetaQuestion("帮我找到 ~/Downloads/报告.pdf")).toBe(false);
    expect(looksLikeCapabilityMetaQuestion("删除 Downloads 里的临时文件")).toBe(false);
  });
});
