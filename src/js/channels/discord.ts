/**
 * Discord 集成模块 - 智能路由到单Bot或多Bot系统
 *
 * 自动检测配置类型：
 * - 如果是单个bot配置 → 使用传统系统（向后兼容）
 * - 如果是多个bot配置 → 使用新的无状态协作系统
 */

import type { ChannelConfig, DiscordBotConfig } from "../shared/config.js";
import type { ChatEngine } from "../core/engine.js";
import type { AgentRouterAdminApi } from "../agents/router.js";
import { log } from "../shared/logger.js";

// 导入传统单Bot系统
import {
  startDiscordChannel as originalStartDiscordChannel,
  type DiscordStatus,
  type DiscordRuntime
} from "./discord-legacy.js";

// 导入新的多Bot系统
import {
  startMultipleDiscordBots,
  shouldUseMultiBotMode,
  type MultiBotStatus
} from "./discord-multi-bot.js";

/**
 * 智能启动Discord频道
 * 根据配置自动选择单Bot或多Bot模式
 */
export function startDiscordChannel(
  config: ChannelConfig | DiscordBotConfig | DiscordBotConfig[] | undefined,
  agent: ChatEngine,
  adminApi?: AgentRouterAdminApi
): DiscordRuntime {
  // 检测是否是多Bot模式
  if (shouldUseMultiBotMode(config)) {
    log("info", "discord.mode.multi_bot", {
      count: config.length,
      bots: config.map(c => ({ name: c.name, agentId: c.agentId }))
    });

    // 启动多Bot模式（异步，但不阻塞）
    void startMultipleDiscordBots(config, agent);

    // 返回一个兼容的runtime对象
    return createMultiBotRuntime(config);
  }

  // 单Bot模式：使用传统系统
  log("info", "discord.mode.single_bot");
  return originalStartDiscordChannel(config, agent, adminApi);
}

/**
 * 为多Bot模式创建兼容的Runtime对象
 */
function createMultiBotRuntime(configs: DiscordBotConfig[]): DiscordRuntime {
  const status: DiscordStatus = {
    enabled: configs.some(c => c.enabled),
    connected: false, // 会在bots启动后更新
    attempts: 0,
    retryInMs: null
  };

  return {
    getStatus: () => ({ ...status }),
    sendDm: async () => ({
      ok: false,
      error: "DM not supported in multi-bot mode"
    })
  };
}

// 重新导出类型
export type { DiscordStatus, DiscordRuntime } from "./discord-legacy.js";
