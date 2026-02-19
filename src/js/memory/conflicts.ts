export type FactConflict = { key: string; prev: string; next: string };

function parseFactLine(line: string): { key: string; value: string } | null {
  const idx = line.indexOf(":");
  if (idx === -1) return null;
  const key = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).trim();
  if (!key || !value) return null;
  return { key, value };
}

function buildFactMap(items: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    const parsed = parseFactLine(item);
    if (!parsed) continue;
    map.set(parsed.key, parsed.value);
  }
  return map;
}

export function detectFactConflicts(existing: string[], incoming: string[]): FactConflict[] {
  if (incoming.length === 0 || existing.length === 0) return [];
  const map = buildFactMap(existing);
  const conflicts: FactConflict[] = [];
  for (const fact of incoming) {
    const parsed = parseFactLine(fact);
    if (!parsed) continue;
    const prev = map.get(parsed.key);
    if (!prev) continue;
    if (prev !== parsed.value) conflicts.push({ key: parsed.key, prev, next: parsed.value });
  }
  return conflicts.slice(0, 4);
}

