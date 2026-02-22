/**
 * Telegram 多 Bot 协作系统
 *
 * 镜像 discord-multi-bot.ts 的无状态、观察者模式多 Bot 管理器。
 * 每个 Bot 独立运行，自主决策，不相互通信。
 * 使用共享 ConversationStore 替代 Discord 的频道历史 API。
 */

import TelegramBot from "node-telegram-bot-api";
import type { TelegramBotConfig } from "../shared/config.js";
import type { ChatEngine } from "../core/engine.js";
import { log } from "../shared/logger.js";
import { TelegramBotHandler } from "./telegram-bot-handler.js";
import { ConversationStore } from "./telegram-conversation-store.js";
import { getRoleConfig, aiDecideObservationDelay } from "./bot-roles.js";
import { globalConfig } from "../shared/config-manager.js";

export interface TelegramMultiBotStatus {
  bots: Array<{
    name: string;
    agentId: string;
    connected: boolean;
    user?: string;
    error?: string;
  }>;
}

/**
 * 启动单个 Telegram Bot
 */
async function startSingleBot(
  config: TelegramBotConfig,
  agent: ChatEngine,
  conversationStore: ConversationStore
): Promise<{ bot: TelegramBot; handler: TelegramBotHandler } | null> {
  if (!config.enabled || !config.token) {
    log("info", "telegram.multi_bot.bot_disabled", { name: config.name });
    return null;
  }

  try {
    const proxyUrl = config.proxyUrl || process.env.TELEGRAM_PROXY_URL;

    // 构建 polling 选项
    const pollingOptions: TelegramBot.ConstructorOptions = {
      polling: true
    };

    if (proxyUrl) {
      pollingOptions.request = {
        proxy: proxyUrl
      } as any;
      log("info", "telegram.multi_bot.proxy.enabled", {
        name: config.name,
        proxyUrl: maskUrl(proxyUrl)
      });
    }

    // 【AI 驱动】获取角色配置，让 AI 决定观察延迟
    const agentId = config.agentId || "unknown";
    let roleConfig = getRoleConfig(agentId);

    if (roleConfig.participationStrategy === "ai_decide" && roleConfig.observationDelay === 0) {
      // 先尝试从配置管理器加载已保存的延迟值（与 discord-multi-bot 保持一致）
      const configKey = `telegram.bot.roles.${agentId}.observationDelay`;
      const savedDelay = globalConfig.getConfig<number>(configKey);

      if (savedDelay !== undefined && savedDelay > 0) {
        roleConfig = { ...roleConfig, observationDelay: savedDelay };
        log("info", "telegram.multi_bot.delay_loaded", {
          name: config.name,
          role: roleConfig.name,
          delayMs: savedDelay,
          delaySec: (savedDelay / 1000).toFixed(1),
          source: "config"
        });
      } else {
        log("info", "telegram.multi_bot.deciding_delay", {
          name: config.name,
          role: roleConfig.name
        });

        const aiDelay = await aiDecideObservationDelay(agent, roleConfig);
        roleConfig = { ...roleConfig, observationDelay: aiDelay };

        // 保存到配置管理器，下次重启直接复用
        globalConfig.setConfig(configKey, aiDelay, "override");

        log("info", "telegram.multi_bot.delay_decided", {
          name: config.name,
          role: roleConfig.name,
          delayMs: aiDelay,
          delaySec: (aiDelay / 1000).toFixed(1)
        });
      }
    }

    // 创建 Telegram Bot 实例
    const bot = new TelegramBot(config.token, pollingOptions);

    // 创建 Handler（传入 AI 决定的 roleConfig + 共享 conversationStore）
    const handler = new TelegramBotHandler(config, agent, bot, conversationStore, roleConfig);

    // 获取 bot 信息
    const me = await bot.getMe();

    log("info", "telegram.multi_bot.bot_ready", {
      name: config.name,
      agentId: config.agentId,
      user: `@${me.username}`
    });

    // 监听消息
    bot.on("message", async (msg) => {
      try {
        await handler.handleMessage(msg);
      } catch (error) {
        log("error", "telegram.multi_bot.message_error", {
          name: config.name,
          error: String(error)
        });
      }
    });

    // 监听 polling 错误
    bot.on("polling_error", (error) => {
      log("error", "telegram.multi_bot.polling_error", {
        name: config.name,
        error: String(error)
      });
    });

    log("info", "telegram.multi_bot.bot_started", {
      name: config.name,
      agentId: config.agentId,
      user: `@${me.username}`
    });

    return { bot, handler };
  } catch (error) {
    log("error", "telegram.multi_bot.bot_start_failed", {
      name: config.name,
      error: String(error)
    });
    return null;
  }
}

/**
 * 启动多个 Telegram Bots
 */
export async function startMultipleTelegramBots(
  configs: TelegramBotConfig[],
  agent: ChatEngine
): Promise<TelegramMultiBotStatus> {
  log("info", "telegram.multi_bot.starting", { count: configs.length });

  const bots: TelegramMultiBotStatus["bots"] = [];
  const clients: Array<{ bot: TelegramBot; handler: TelegramBotHandler }> = [];

  // 创建共享 ConversationStore（所有 bot 共用）
  const conversationStore = new ConversationStore();

  // 顺序启动每个 bot
  for (const config of configs) {
    const result = await startSingleBot(config, agent, conversationStore);

    if (result) {
      clients.push(result);
      bots.push({
        name: config.name || "unknown",
        agentId: config.agentId || "unknown",
        connected: true,
        user: undefined // 已在 startSingleBot 中 log
      });
    } else {
      bots.push({
        name: config.name || "unknown",
        agentId: config.agentId || "unknown",
        connected: false,
        error: "Failed to start"
      });
    }
  }

  log("info", "telegram.multi_bot.started", {
    total: configs.length,
    connected: clients.length,
    bots: bots.map(b => ({ name: b.name, agentId: b.agentId, connected: b.connected }))
  });

  // 优雅关闭处理
  process.on("SIGINT", async () => {
    log("info", "telegram.multi_bot.shutting_down");

    for (const { bot, handler } of clients) {
      handler.cleanup();
      bot.stopPolling();
    }
    conversationStore.destroy();

    log("info", "telegram.multi_bot.shutdown_complete");
  });

  return { bots };
}

/**
 * 检测是否应该使用多 Bot 模式
 */
export function shouldUseTelegramMultiBotMode(
  config: TelegramBotConfig | TelegramBotConfig[] | unknown
): config is TelegramBotConfig[] {
  return Array.isArray(config) && config.length > 0;
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = u.username ? "***" : "";
      u.password = u.password ? "***" : "";
    }
    return u.toString();
  } catch {
    return "***";
  }
}
