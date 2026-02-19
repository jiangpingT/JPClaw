import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type AgentSpec = {
  id: string;
  name: string;
  createdAt: string;
  enabled: boolean;
};

export type AgentBindings = {
  discord: Record<string, string>;
};

type AdminState = {
  agents: Record<string, AgentSpec>;
  bindings: AgentBindings;
  defaultAgentId: string;
};

const DEFAULT_AGENT_ID = "default";

function nowIso(): string {
  return new Date().toISOString();
}

function defaultState(): AdminState {
  return {
    agents: {
      [DEFAULT_AGENT_ID]: {
        id: DEFAULT_AGENT_ID,
        name: "JPClaw Default",
        createdAt: nowIso(),
        enabled: true
      }
    },
    bindings: { discord: {} },
    defaultAgentId: DEFAULT_AGENT_ID
  };
}

function normalizeAgentId(input: string): string {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

export class AgentAdminStore {
  private readonly filePath: string;
  private cache: AdminState | null = null;

  constructor(baseDir = path.resolve(process.cwd(), "sessions", "agents")) {
    this.filePath = path.join(baseDir, "admin.json");
    mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  private load(): AdminState {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = defaultState();
      this.persist();
      return this.cache;
    }

    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as Partial<AdminState>;
      const state = defaultState();
      if (parsed.defaultAgentId && state.agents[parsed.defaultAgentId]) {
        state.defaultAgentId = parsed.defaultAgentId;
      }
      if (parsed.agents && typeof parsed.agents === "object") {
        for (const [key, value] of Object.entries(parsed.agents)) {
          const id = normalizeAgentId(key);
          if (!id) continue;
          state.agents[id] = {
            id,
            name: String((value as AgentSpec).name || id),
            createdAt: String((value as AgentSpec).createdAt || nowIso()),
            enabled: (value as AgentSpec).enabled !== false
          };
        }
      }
      if (parsed.bindings?.discord && typeof parsed.bindings.discord === "object") {
        state.bindings.discord = {};
        for (const [channelId, agentIdRaw] of Object.entries(parsed.bindings.discord)) {
          const agentId = normalizeAgentId(String(agentIdRaw || ""));
          if (!agentId || !state.agents[agentId]) continue;
          state.bindings.discord[String(channelId)] = agentId;
        }
      }
      if (!state.agents[state.defaultAgentId]) state.defaultAgentId = DEFAULT_AGENT_ID;
      this.cache = state;
      this.persist();
      return state;
    } catch {
      this.cache = defaultState();
      this.persist();
      return this.cache;
    }
  }

  private persist(): void {
    if (!this.cache) return;
    writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2));
  }

  listAgents(): AgentSpec[] {
    const state = this.load();
    return Object.values(state.agents).sort((a, b) => a.id.localeCompare(b.id));
  }

  createAgent(input: { id: string; name?: string }): AgentSpec {
    const state = this.load();
    const id = normalizeAgentId(input.id);
    if (!id) throw new Error("invalid_agent_id");
    if (state.agents[id]) throw new Error("agent_already_exists");
    const spec: AgentSpec = {
      id,
      name: input.name?.trim() || id,
      createdAt: nowIso(),
      enabled: true
    };
    state.agents[id] = spec;
    this.persist();
    return spec;
  }

  bindDiscordChannel(channelId: string, agentIdInput: string): { channelId: string; agentId: string } {
    const state = this.load();
    const agentId = normalizeAgentId(agentIdInput);
    if (!agentId || !state.agents[agentId]) throw new Error("agent_not_found");
    const ch = String(channelId || "").trim();
    if (!ch) throw new Error("invalid_channel_id");
    state.bindings.discord[ch] = agentId;
    this.persist();
    return { channelId: ch, agentId };
  }

  unbindDiscordChannel(channelId: string): { channelId: string; removed: boolean } {
    const state = this.load();
    const ch = String(channelId || "").trim();
    if (!ch) throw new Error("invalid_channel_id");
    const removed = Object.prototype.hasOwnProperty.call(state.bindings.discord, ch);
    if (removed) {
      delete state.bindings.discord[ch];
      this.persist();
    }
    return { channelId: ch, removed };
  }

  deleteAgent(agentIdInput: string): { id: string; removed: boolean } {
    const state = this.load();
    const agentId = normalizeAgentId(agentIdInput);
    if (!agentId) throw new Error("invalid_agent_id");
    if (!state.agents[agentId]) throw new Error("agent_not_found");
    if (agentId === state.defaultAgentId) throw new Error("cannot_delete_default_agent");

    const inUseChannels = Object.entries(state.bindings.discord)
      .filter(([, a]) => a === agentId)
      .map(([channelId]) => channelId);
    if (inUseChannels.length > 0) {
      throw new Error(`agent_bound_to_channels:${inUseChannels.join(",")}`);
    }

    delete state.agents[agentId];
    this.persist();
    return { id: agentId, removed: true };
  }

  listBindings(): AgentBindings {
    const state = this.load();
    return {
      discord: { ...state.bindings.discord }
    };
  }

  resolveAgentForContext(context: { channelId?: string }): string {
    const state = this.load();
    const ch = context.channelId ? String(context.channelId) : "";
    if (ch && state.bindings.discord[ch]) return state.bindings.discord[ch];
    return state.defaultAgentId;
  }

  getState(): { defaultAgentId: string; agents: AgentSpec[]; bindings: AgentBindings } {
    const state = this.load();
    return {
      defaultAgentId: state.defaultAgentId,
      agents: this.listAgents(),
      bindings: this.listBindings()
    };
  }
}
