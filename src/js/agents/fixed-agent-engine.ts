import type { ChatEngine, ReplyContext } from "../core/engine.js";
import type { MultiAgentRouter } from "./router.js";

/**
 * FixedAgentEngine - 强制使用指定agent的引擎包装器
 *
 * 用于Discord多bot场景：每个bot固定使用一个特定的agent角色
 * 而不是根据channel动态选择agent
 */
export class FixedAgentEngine implements ChatEngine {
  constructor(
    private readonly router: MultiAgentRouter,
    private readonly fixedAgentId: string
  ) {}

  async reply(input: string, context: ReplyContext = {}): Promise<string> {
    // 强制使用固定的agentId，通过创建临时channel绑定实现
    // 使用特殊的channel ID格式来避免冲突
    const virtualChannelId = `__bot_agent_${this.fixedAgentId}_${context.channelId || "default"}`;

    // 确保该虚拟channel绑定到指定的agent
    const admin = this.router.adminApi();

    // 检查是否已存在该agent，如果不存在则创建
    const existingAgents = admin.listAgents();
    if (!existingAgents.some(a => a.id === this.fixedAgentId)) {
      admin.createAgent({ id: this.fixedAgentId });
    }

    // 绑定虚拟channel到固定的agent
    admin.bindDiscordChannel(virtualChannelId, this.fixedAgentId);

    // 使用虚拟channel调用router
    const modifiedContext: ReplyContext = {
      ...context,
      channelId: virtualChannelId
    };

    return this.router.reply(input, modifiedContext);
  }

  recordExternalExchange(input: string, output: string, context: ReplyContext = {}): void {
    const virtualChannelId = `__bot_agent_${this.fixedAgentId}_${context.channelId || "default"}`;
    const modifiedContext: ReplyContext = {
      ...context,
      channelId: virtualChannelId
    };

    this.router.recordExternalExchange?.(input, output, modifiedContext);
  }
}
