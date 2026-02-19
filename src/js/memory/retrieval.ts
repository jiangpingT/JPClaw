type Scored<T> = { item: T; score: number; order: number };

function hasHan(text: string): boolean {
  return /[\p{Script=Han}]/u.test(text);
}

function addHanBigrams(token: string, out: Set<string>): void {
  const clean = token.replace(/\s+/g, "");
  if (clean.length < 2) return;
  // Limit bigrams to keep it cheap and avoid blowing up for very long strings.
  const maxLen = Math.min(clean.length, 40);
  for (let i = 0; i < maxLen - 1; i += 1) {
    out.add(clean.slice(i, i + 2));
  }
}

export function tokenizeForRetrieval(input: string): Set<string> {
  const normalized = input.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
  const raw = normalized
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);

  const tokens = new Set<string>();
  for (const chunk of raw) {
    if (chunk.length >= 2) tokens.add(chunk);
    if (hasHan(chunk)) addHanBigrams(chunk, tokens);
  }
  return tokens;
}

export type ScoredItem = { item: string; score: number; order: number };

export function scoreItemsForRetrieval(input: string, items: string[]): ScoredItem[] {
  if (items.length === 0) return [];
  const q = tokenizeForRetrieval(input);
  if (q.size === 0) {
    // Preserve original order when we can't score.
    return items.map((item, idx) => ({ item, score: 0, order: idx + 1 }));
  }

  const tokenDf = new Map<string, number>();
  for (const item of items) {
    const t = tokenizeForRetrieval(item);
    for (const token of t) {
      tokenDf.set(token, (tokenDf.get(token) || 0) + 1);
    }
  }
  const totalDocs = items.length + 1;

  const scored: ScoredItem[] = [];
  let order = 0;
  for (const item of items) {
    order += 1;
    const t = tokenizeForRetrieval(item);
    let overlap = 0;
    for (const token of q) {
      if (t.has(token)) {
        const df = tokenDf.get(token) || 0;
        const idf = Math.log((totalDocs + 1) / (df + 1)) + 1;
        overlap += idf;
      }
    }
    // Small domain anchors to help stability.
    const anchors = ["使命", "愿景", "价值观", "天赋", "合一", "可信", "明略", "战略"];
    for (const a of anchors) {
      if (input.includes(a) && item.includes(a)) overlap += 2;
    }
    if (item.includes(input.trim()) && input.trim().length >= 4) overlap += 3;
    scored.push({ item, score: overlap, order });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.order - a.order;
  });
  return scored;
}

export function selectRelevantItems(input: string, items: string[], limit: number): string[] {
  if (items.length === 0) return [];
  const scored = scoreItemsForRetrieval(input, items);
  const picked = scored.slice(0, limit).map((x) => x.item);
  // Keep the previous behavior: return items in a more "chronological" order to reduce churn.
  return picked.reverse();
}

function normalize01(values: number[]): number[] {
  if (values.length === 0) return [];
  let max = 0;
  for (const v of values) max = Math.max(max, Number.isFinite(v) ? v : 0);
  if (max <= 0) return values.map(() => 0);
  return values.map((v) => {
    const n = Number.isFinite(v) ? v : 0;
    return Math.max(0, Math.min(1, n / max));
  });
}

export function fuseHeuristicAndBm25(options: {
  heuristic: ScoredItem[];
  bm25Hits: Array<{ content: string; score: number }>;
  heuristicWeight: number;
  bm25Weight: number;
  pinned?: Set<string>;
  limit: number;
}): string[] {
  const hw = Number.isFinite(options.heuristicWeight) ? options.heuristicWeight : 0.7;
  const bw = Number.isFinite(options.bm25Weight) ? options.bm25Weight : 0.3;
  const sum = hw + bw;
  const heuristicWeight = sum > 0 ? hw / sum : 0.7;
  const bm25Weight = sum > 0 ? bw / sum : 0.3;

  const heurNormScores = normalize01(options.heuristic.map((h) => h.score));
  const heurByItem = new Map<string, { score01: number; order: number }>();
  for (let i = 0; i < options.heuristic.length; i += 1) {
    const h = options.heuristic[i]!;
    heurByItem.set(h.item, { score01: heurNormScores[i] || 0, order: h.order });
  }

  const bm25NormScores = normalize01(options.bm25Hits.map((h) => h.score));
  const bm25ByItem = new Map<string, number>();
  for (let i = 0; i < options.bm25Hits.length; i += 1) {
    const h = options.bm25Hits[i]!;
    const content = String(h.content || "").trim();
    if (!content) continue;
    bm25ByItem.set(content, bm25NormScores[i] || 0);
  }

  const allItems = new Set<string>();
  for (const h of options.heuristic) allItems.add(h.item);
  for (const h of options.bm25Hits) {
    const c = String(h.content || "").trim();
    if (c) allItems.add(c);
  }

  const pinned = options.pinned || new Set<string>();
  const scored: Array<{ item: string; score: number; order: number }> = [];
  for (const item of allItems) {
    const heur = heurByItem.get(item);
    const hScore = heur?.score01 || 0;
    const bScore = bm25ByItem.get(item) || 0;
    const fused = heuristicWeight * hScore + bm25Weight * bScore;
    const boost = pinned.has(item) ? 0.05 : 0;
    scored.push({ item, score: fused + boost, order: heur?.order || 0 });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.order - a.order;
  });
  return scored
    .filter((x) => x.item && x.score > 0)
    .slice(0, Math.max(1, options.limit))
    .map((x) => x.item);
}
