/** 迁移自 tests/js/heartbeat.spec.ts → Vitest 统一框架 */
import { describe, it, expect } from 'vitest';
import fs from "node:fs";
import path from "node:path";
import { HeartbeatService } from "../../src/js/heartbeat/service.js";

describe('heartbeat', () => {
  it("should heartbeat writes an inbox file", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), "sessions", "hbtest-"));
    try {
      const hb = new HeartbeatService({
        enabled: true,
        intervalMinutes: 9999,
        inboxDir: dir,
        ownerUserId: "u1",
        ownerDmEnabled: false,
        ownerDmMode: "important",
        startupGraceSeconds: 60,
        disconnectDmThreshold: 2
      });
      hb.start(null);
      await new Promise((r) => setTimeout(r, 50));
      hb.stop();

      const files = fs.readdirSync(dir).filter((f) => f.startsWith("heartbeat-") && f.endsWith(".md"));
      expect(files.length >= 1).toBeTruthy();
      const content = fs.readFileSync(path.join(dir, files[0]), "utf-8");
      expect(content.includes("JPClaw Heartbeat Inbox")).toBeTruthy();
      expect(content.includes("discord: not_configured")).toBeTruthy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
