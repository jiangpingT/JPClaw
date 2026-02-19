/** 迁移自 tests/js/transcript-external-exchange.spec.ts → Vitest 统一框架 */
import { describe, it, expect } from 'vitest';
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { PiEngine } from "../../src/js/pi/engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

function transcriptPathFor(sessionKey: string): string {
  const hash = createHash("sha256").update(sessionKey).digest("hex").slice(0, 24);
  return path.join(repoRoot, "sessions", "pi", "transcripts", `t_${hash}.jsonl`);
}

describe('transcript-external-exchange', () => {
  it("should recordExternalExchange appends exactly 2 transcript lines (user+assistant)", () => {
    const userId = `test_user_${Date.now()}`;
    const channelId = `test_channel_${Math.random().toString(36).slice(2, 8)}`;
    const sessionKey = `${userId}::${channelId}`;
    const transcript = transcriptPathFor(sessionKey);

    const config: any = {
      providers: [
        { type: "anthropic", apiKey: "test", model: "claude-3-5-sonnet-20240620" }
      ],
      channels: {}
    };
    const engine = new PiEngine(config);

    const before = fs.existsSync(transcript) ? fs.readFileSync(transcript, "utf8").trimEnd().split("\n").length : 0;
    engine.recordExternalExchange?.(
      "演示：认知增强型知识发现流程 https://docs.openclaw.ai/tools/skills",
      "已记录：这条消息由外部路由处理，但仍会写入会话转录，避免上下文断裂。",
      { userId, channelId, userName: "tester" }
    );
    const after = fs.readFileSync(transcript, "utf8").trimEnd().split("\n").length;

    expect(after - before).toBe(2);
  });
});
