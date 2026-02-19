/**
 * 文本分块工具测试
 * 迁移自 tests/js/text-chunk.spec.ts → Vitest 统一框架
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolveMessageChunkLimit, splitTextIntoChunks } from "../../../src/js/shared/text-chunk.js";

describe('splitTextIntoChunks', () => {
  it('should split long text and keep all content', () => {
    const source = `line1\n${"a".repeat(120)}\n${"b".repeat(120)}\nline4`;
    const chunks = splitTextIntoChunks(source, { maxLength: 100 });

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.join("")).toContain("line1");
    expect(chunks.join("")).toContain("line4");
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100);
    }
  });
});

describe('resolveMessageChunkLimit', () => {
  const originalGlobal = process.env.JPCLAW_MESSAGE_CHUNK_LIMIT;
  const originalDiscord = process.env.JPCLAW_MESSAGE_CHUNK_LIMIT_DISCORD;

  afterEach(() => {
    if (originalGlobal === undefined) delete process.env.JPCLAW_MESSAGE_CHUNK_LIMIT;
    else process.env.JPCLAW_MESSAGE_CHUNK_LIMIT = originalGlobal;
    if (originalDiscord === undefined) delete process.env.JPCLAW_MESSAGE_CHUNK_LIMIT_DISCORD;
    else process.env.JPCLAW_MESSAGE_CHUNK_LIMIT_DISCORD = originalDiscord;
  });

  it('should respect channel-specific env over global', () => {
    process.env.JPCLAW_MESSAGE_CHUNK_LIMIT = "1500";
    process.env.JPCLAW_MESSAGE_CHUNK_LIMIT_DISCORD = "1800";
    expect(resolveMessageChunkLimit("discord", 1900)).toBe(1800);
  });

  it('should fall back to global when channel-specific is not set', () => {
    process.env.JPCLAW_MESSAGE_CHUNK_LIMIT = "1500";
    delete process.env.JPCLAW_MESSAGE_CHUNK_LIMIT_DISCORD;
    expect(resolveMessageChunkLimit("discord", 1900)).toBe(1500);
  });
});
