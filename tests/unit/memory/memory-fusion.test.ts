/** 迁移自 tests/js/memory-fusion.spec.ts → Vitest 统一框架 */
import { describe, it, expect } from 'vitest';

import { fuseHeuristicAndBm25, type ScoredItem } from "../../src/js/memory/retrieval.js";

describe('memory-fusion', () => {
  it("should fusion: prefers heuristic when weights are 0.7/0.3", () => {
    const heuristic: ScoredItem[] = [
      { item: "使命(简): 把可信智能带给身边的人", score: 50, order: 1 },
      { item: "合一模型: 可信*智能", score: 20, order: 2 }
    ];
    const bm25Hits = [
      { content: "合一模型: 可信*智能", score: 100 },
      { content: "使命(简): 把可信智能带给身边的人", score: 1 }
    ];
    const out = fuseHeuristicAndBm25({
      heuristic,
      bm25Hits,
      heuristicWeight: 0.7,
      bm25Weight: 0.3,
      pinned: new Set<string>(),
      limit: 2
    });
    expect(out[0]).toBe("使命(简): 把可信智能带给身边的人");
    expect(out[1]).toBe("合一模型: 可信*智能");
  });

  it("should fusion: pinned note gets a small boost", () => {
    const heuristic: ScoredItem[] = [
      { item: "A", score: 10, order: 1 },
      { item: "B", score: 10, order: 2 }
    ];
    const bm25Hits = [
      { content: "A", score: 10 },
      { content: "B", score: 10 }
    ];
    const out = fuseHeuristicAndBm25({
      heuristic,
      bm25Hits,
      heuristicWeight: 0.7,
      bm25Weight: 0.3,
      pinned: new Set<string>(["B"]),
      limit: 2
    });
    expect(out[0]).toBe("B");
  });
});
