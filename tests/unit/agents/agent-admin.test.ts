/** 迁移自 tests/js/agent-admin.spec.ts → Vitest 统一框架 */
import { describe, it, expect } from 'vitest';
import fs from "node:fs";
import path from "node:path";
import { AgentAdminStore } from "../../src/js/agents/admin-store.js";

describe('agent-admin', () => {
  it("should agent admin store can create and bind discord channel", () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), "sessions", "agent-admin-"));
    try {
      const store = new AgentAdminStore(dir);
      const created = store.createAgent({ id: "JPClaw_Manager", name: "Manager" });
      expect(created.id).toBe("jpclaw_manager");

      const binding = store.bindDiscordChannel("123", "jpclaw_manager");
      expect(binding.channelId).toBe("123");
      expect(binding.agentId).toBe("jpclaw_manager");

      const state = store.getState();
      expect(state.bindings.discord["123"]).toBe("jpclaw_manager");
      expect(state.agents.some((x) => x.id === "jpclaw_manager")).toBeTruthy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should agent delete safety rules and unbind flow", () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), "sessions", "agent-admin-"));
    try {
      const store = new AgentAdminStore(dir);
      expect(() => store.deleteAgent("default")).toThrow(/cannot_delete_default_agent/);

      store.createAgent({ id: "jpclaw2" });
      store.bindDiscordChannel("c1", "jpclaw2");
      expect(() => store.deleteAgent("jpclaw2")).toThrow(/agent_bound_to_channels/);

      const unbound = store.unbindDiscordChannel("c1");
      expect(unbound.removed).toBe(true);

      const removed = store.deleteAgent("jpclaw2");
      expect(removed.removed).toBe(true);
      expect(removed.id).toBe("jpclaw2");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
