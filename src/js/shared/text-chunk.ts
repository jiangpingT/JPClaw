export type ChunkOptions = {
  maxLength?: number;
  minSplitRatio?: number;
};

const DEFAULT_MAX_LENGTH = 1900;
const DEFAULT_MIN_SPLIT_RATIO = 0.6;

export function splitTextIntoChunks(text: string, options: ChunkOptions = {}): string[] {
  const raw = String(text || "");
  const maxLength = Math.max(50, options.maxLength ?? DEFAULT_MAX_LENGTH);
  const minSplitAt = Math.floor(maxLength * (options.minSplitRatio ?? DEFAULT_MIN_SPLIT_RATIO));

  if (raw.length <= maxLength) return [raw];

  const chunks: string[] = [];
  let rest = raw;
  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf("\n", maxLength);
    if (cut < minSplitAt) {
      cut = rest.lastIndexOf(" ", maxLength);
    }
    if (cut < minSplitAt) {
      cut = maxLength;
    }
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

export function resolveMessageChunkLimit(channelName: string, fallback: number): number {
  const normalize = (v: string | undefined): number | null => {
    if (!v) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 200) return null;
    return Math.floor(n);
  };

  const common = normalize(process.env.JPCLAW_MESSAGE_CHUNK_LIMIT);
  const channel = normalize(
    process.env[`JPCLAW_MESSAGE_CHUNK_LIMIT_${channelName.toUpperCase()}`]
  );
  return channel ?? common ?? fallback;
}
