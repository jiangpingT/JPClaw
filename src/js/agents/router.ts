import type { ChatEngine, ReplyContext } from "../core/engine.js";
import type { JPClawConfig } from "../shared/config.js";
import { PiEngine } from "../pi/engine.js";
import { AgentAdminStore, type AgentSpec } from "./admin-store.js";

export type AgentRouterAdminApi = {
  listAgents: () => AgentSpec[];
  listBindings: () => { discord: Record<string, string> };
  createAgent: (input: { id: string; name?: string }) => AgentSpec;
  bindDiscordChannel: (channelId: string, agentId: string) => { channelId: string; agentId: string };
  unbindDiscordChannel: (channelId: string) => { channelId: string; removed: boolean };
  deleteAgent: (agentId: string) => { id: string; removed: boolean };
  getDefaultAgentId: () => string;
};

/**
 * 优化：使用安全的编码方式避免身份空间污染
 *
 * 问题：之前使用 `${agentId}::${userId}` 拼接方式，如果userId本身包含"::"会导致冲突
 * 解决：使用Base64编码，完全避免分隔符问题
 */
function namespaceUserId(agentId: string, userId?: string): string {
  const id = userId || "local";

  // 使用JSON + Base64编码，确保无歧义
  const namespace = JSON.stringify({ agentId, userId: id });
  return Buffer.from(namespace).toString('base64');
}

/**
 * 反向解析namespaced userId（如果将来需要）
 */
function parseNamespacedUserId(namespaced: string): { agentId: string; userId: string } {
  try {
    const namespace = Buffer.from(namespaced, 'base64').toString('utf8');
    const parsed = JSON.parse(namespace);
    return {
      agentId: parsed.agentId || "default",
      userId: parsed.userId || "local"
    };
  } catch {
    // 兼容旧格式（agentId::userId）
    const parts = namespaced.split('::');
    return {
      agentId: parts[0] || "default",
      userId: parts[1] || "local"
    };
  }
}

export class MultiAgentRouter implements ChatEngine {
  private readonly store: AgentAdminStore;
  private readonly engines = new Map<string, PiEngine>();

  constructor(private readonly config: JPClawConfig, store?: AgentAdminStore) {
    this.store = store || new AgentAdminStore();
  }

  private getEngine(agentId: string): PiEngine {
    const cached = this.engines.get(agentId);
    if (cached) return cached;
    const engine = new PiEngine(this.config);
    this.engines.set(agentId, engine);
    return engine;
  }

  private pickAgentId(context: ReplyContext = {}): string {
    return this.store.resolveAgentForContext({ channelId: context.channelId });
  }

  private toAgentContext(agentId: string, context: ReplyContext = {}): ReplyContext {
    return {
      ...context,
      userId: namespaceUserId(agentId, context.userId)
    };
  }

  async reply(input: string, context: ReplyContext = {}): Promise<string> {
    const agentId = this.pickAgentId(context);
    const engine = this.getEngine(agentId);
    return engine.reply(input, this.toAgentContext(agentId, context));
  }

  recordExternalExchange(input: string, output: string, context: ReplyContext = {}): void {
    const agentId = this.pickAgentId(context);
    const engine = this.getEngine(agentId);
    engine.recordExternalExchange?.(input, output, this.toAgentContext(agentId, context));
  }

  adminApi(): AgentRouterAdminApi {
    return {
      listAgents: () => this.store.listAgents(),
      listBindings: () => this.store.listBindings(),
      createAgent: (input) => this.store.createAgent(input),
      bindDiscordChannel: (channelId, agentId) => this.store.bindDiscordChannel(channelId, agentId),
      unbindDiscordChannel: (channelId) => this.store.unbindDiscordChannel(channelId),
      deleteAgent: (agentId) => this.store.deleteAgent(agentId),
      getDefaultAgentId: () => this.store.getState().defaultAgentId
    };
  }
}
