export type StructuredProfile = {
  missionShort?: string;
  missionFull?: string;
  vision?: string;
  model?: string;
  talent?: string;
  huiTalent?: string;
  oneThing?: string;
  operation?: string;
  values?: string[];
  responseStyle?: string;
  updatedAt?: string;
};

function chunkPinnedNotes(text: string, maxChunk: number, maxChunks: number): string[] {
  if (text.length <= maxChunk) return [text];
  const parts = text
    .split(/\n{2,}/)
    .map((x) => x.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";
  for (const part of parts) {
    if (!current) {
      current = part;
      continue;
    }
    if ((current + "\n\n" + part).length <= maxChunk) {
      current = `${current}\n\n${part}`;
      continue;
    }
    chunks.push(current);
    current = part;
    if (chunks.length >= maxChunks) break;
  }
  if (current && chunks.length < maxChunks) chunks.push(current);

  const trimmed = chunks.slice(0, maxChunks);
  if (trimmed.length === 0) {
    const fallback = text.slice(0, maxChunk);
    return [fallback];
  }
  return trimmed;
}

function redactSecrets(text: string): string {
  // Best-effort redaction to avoid persisting tokens if the user pastes them.
  return text
    .replace(/\bsk-[A-Za-z0-9_\-]{10,}\b/g, "sk-REDACTED")
    .replace(/\bmoltbook_sk_[A-Za-z0-9_\-]{10,}\b/g, "moltbook_sk_REDACTED")
    .replace(/\b(MTQ[\w\-.]{10,})\b/g, "DISCORD_TOKEN_REDACTED");
}

export function extractPinnedNotes(input: string): string[] {
  const text = input.trim();
  if (!text) return [];

  const trigger =
    /记住|记忆|保存|长期记住|帮我记下来|请你帮我记忆下来|以后都按这个|用户需求至上|能力不足就去写程序|安抚用户/i.test(
      text
    );
  if (!trigger) return [];

  const cleaned = text
    .replace(/^[\s:：]*(请)?(你)?(帮我)?(把)?/i, "")
    .replace(/(记住|记忆|保存)(下来)?[：:]?/gi, "")
    .replace(/^[，,\s]+/, "")
    .replace(/[，,\s]*(请|谢谢|多谢|拜托)[。.!！]?$/i, "")
    .trim();
  if (!cleaned) return [];

  return chunkPinnedNotes(redactSecrets(cleaned), 1200, 12);
}

export function profileHasSignals(profile: Partial<StructuredProfile>): boolean {
  return Boolean(
    profile.missionShort ||
      profile.missionFull ||
      profile.vision ||
      profile.model ||
      profile.talent ||
      profile.huiTalent ||
      profile.oneThing ||
      profile.operation ||
      (profile.values && profile.values.length > 0) ||
      profile.responseStyle
  );
}

export function mergeProfile(base: StructuredProfile, delta: Partial<StructuredProfile>): void {
  if (!delta) return;
  if (delta.missionShort) base.missionShort = delta.missionShort;
  if (delta.missionFull) base.missionFull = delta.missionFull;
  if (delta.vision) base.vision = delta.vision;
  if (delta.model) base.model = delta.model;
  if (delta.talent) base.talent = delta.talent;
  if (delta.huiTalent) base.huiTalent = delta.huiTalent;
  if (delta.oneThing) base.oneThing = delta.oneThing;
  if (delta.operation) base.operation = delta.operation;
  if (delta.responseStyle) base.responseStyle = delta.responseStyle;
  if (delta.values && delta.values.length > 0) {
    const merged = new Set([...(base.values || []), ...delta.values]);
    base.values = Array.from(merged).slice(-20);
  }
  if (profileHasSignals(delta)) base.updatedAt = new Date().toISOString();
}

export function extractProfileFromText(text: string): Partial<StructuredProfile> {
  const input = text.trim();
  if (!input) return {};
  const get = (re: RegExp): string | undefined => {
    const m = input.match(re);
    return m?.[1]?.trim();
  };

  // More general mission extraction:
  // - The first "使命:" line becomes missionShort
  // - A line that contains "我姜平" is treated as missionFull
  let missionShort: string | undefined;
  let missionFull: string | undefined;
  const missionMatches = Array.from(input.matchAll(/使命[:：]\s*([^\n]+)/g));
  for (const m of missionMatches) {
    const line = (m?.[1] || "").trim();
    if (!line) continue;
    if (!missionShort) missionShort = line;
    if (!missionFull && /我姜平/.test(line)) missionFull = line;
  }
  const vision = get(/愿景[:：]\s*([^\n]+)/m);
  const model = get(/合一模型[:：]\s*([^\n]+)/m);
  const talent = get(/(?:^|\n)天赋[:：]\s*([^\n]+)/m);
  const huiTalent = get(/辉哥[^\n]*天赋[:：]\s*([^\n]+)/m);
  const oneThing = get(/一件事[:：]\s*([^\n]+)/m);
  const operation = get(/具体操作[:：]\s*([^\n]+)/m);

  const values: string[] = [];
  const valuesMatch = input.match(/价值观[:：]\s*([^\n]+)/m);
  if (valuesMatch?.[1]) {
    for (const part of valuesMatch[1].split(/[，,\/]/).map((x) => x.trim())) {
      if (part) values.push(part);
    }
  }
  if (input.includes("可信")) values.push("可信");
  if (input.includes("用户需求至上")) values.push("用户需求至上");

  let responseStyle: string | undefined;
  if (/用中文/.test(input)) responseStyle = "中文";
  if (/适当.*emoji|可爱.*emoji|图标/.test(input)) {
    responseStyle = responseStyle ? `${responseStyle}, 适当emoji` : "适当emoji";
  }

  const out: Partial<StructuredProfile> = {
    missionShort,
    missionFull,
    vision,
    model,
    talent,
    huiTalent,
    oneThing,
    operation,
    values: values.length > 0 ? values : undefined,
    responseStyle
  };
  return out;
}
