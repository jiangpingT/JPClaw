import fs from "node:fs";
import path from "node:path";

export type PromptBundle = {
  identity: string;
  soul: string;
  agents: string;
  userDefault: string;
};

const DEFAULT_PROMPTS_DIR = "prompts";
const MAX_PROMPT_BYTES = Number(process.env.JPCLAW_PROMPTS_MAX_BYTES || "262144"); // 256 KiB

type CacheEntry = { text: string; mtimeMs: number; size: number };
const cache = new Map<string, CacheEntry>();

function readPromptFile(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return "";
    if (stat.size > MAX_PROMPT_BYTES) {
      return `（提示词文件过大，已跳过：${path.basename(filePath)} size=${stat.size}）`;
    }
    const cached = cache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.text;
    }
    const text = fs.readFileSync(filePath, "utf-8");
    cache.set(filePath, { text, mtimeMs: stat.mtimeMs, size: stat.size });
    return text;
  } catch {
    return "";
  }
}

export function resolvePromptsDir(): string {
  const raw = process.env.JPCLAW_PROMPTS_DIR;
  const dir = raw ? raw.trim() : DEFAULT_PROMPTS_DIR;
  return path.resolve(process.cwd(), dir);
}

export function loadPromptBundle(): PromptBundle {
  const dir = resolvePromptsDir();
  const identity = readPromptFile(path.join(dir, "IDENTITY.md"));
  const soul = readPromptFile(path.join(dir, "SOUL.md"));
  const agents = readPromptFile(path.join(dir, "AGENTS.md"));
  const userDefault = readPromptFile(path.join(dir, "USER_DEFAULT.md"));
  return { identity, soul, agents, userDefault };
}

function normalizeBlock(text: string): string {
  const trimmed = (text || "").trim();
  if (!trimmed) return "";
  return trimmed;
}

export function buildPromptPrelude(options: { isOwner: boolean }): string {
  const bundle = loadPromptBundle();
  const blocks = [
    normalizeBlock(bundle.identity),
    options.isOwner
      ? "（当前用户是主用户 owner：可以称呼“姜哥”，你的名字叫“阿策”。）"
      : "（当前用户不是主用户：不要称呼“姜哥”。）",
    normalizeBlock(bundle.soul),
    normalizeBlock(bundle.agents),
    normalizeBlock(bundle.userDefault)
  ].filter(Boolean);
  if (blocks.length === 0) return "";
  return blocks.join("\n\n");
}

