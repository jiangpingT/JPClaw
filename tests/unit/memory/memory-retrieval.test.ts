/** 迁移自 tests/js/memory-retrieval.spec.ts → Vitest 统一框架 */
import { describe, it, expect } from 'vitest';
import { selectRelevantItems } from "../../src/js/memory/retrieval.js";

describe('memory-retrieval', () => {
  it("should selectRelevantItems prefers overlapping Chinese bigrams", () => {
    const items = [
      "使命(短): 把可信智能带给身边的人",
      "用户位置: 北京",
      "随机内容: abcdefg"
    ];
    const picked = selectRelevantItems("我的使命是什么", items, 2);
    expect(picked.some((x) => x.includes("使命"))).toBeTruthy();
  });
});
