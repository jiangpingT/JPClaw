/**
 * Discord 多Bot协作系统
 *
 * 全新的无状态、观察者模式的多Bot管理器
 * 每个Bot独立运行，自主决策，不相互通信
 */

import type { Client, Message } from "discord.js";
import type { DiscordBotConfig } from "../shared/config.js";
import type { ChatEngine } from "../core/engine.js";
import { log } from "../shared/logger.js";
import { loadEnv } from "../shared/env.js";
import { ProxyAgent } from "undici";
import { DiscordBotHandler } from "./discord-bot-handler.js";
import { getRoleConfig, aiDecideObservationDelay } from "./bot-roles.js";

loadEnv();

export interface MultiBotStatus {
  bots: Array<{
    name: string;
    agentId: string;
    connected: boolean;
    user?: string;
    error?: string;
  }>;
}

/**
 * 启动单个Discord Bot
 */
async function startSingleBot(
  config: DiscordBotConfig,
  agent: ChatEngine
): Promise<{ client: Client; handler: DiscordBotHandler } | null> {
  if (!config.enabled || !config.token) {
    log("info", "discord.multi_bot.bot_disabled", { name: config.name });
    return null;
  }

  try {
    // 动态加载discord.js
    const { Client, GatewayIntentBits, Partials } = await import("discord.js");

    // 代理配置
    const proxyUrl = process.env.DISCORD_PROXY_URL;
    const proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

    // 创建Client
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
      ],
      partials: [Partials.Channel, Partials.Message],
      rest: proxyAgent ? { agent: proxyAgent } : undefined
    });

    // 【AI驱动】获取角色配置，让AI决定观察延迟
    const agentId = config.agentId || "unknown";
    let roleConfig = getRoleConfig(agentId);

    // 如果需要观察延迟（ai_decide策略），让AI决定延迟时间
    if (roleConfig.participationStrategy === "ai_decide" && roleConfig.observationDelay === 0) {
      log("info", "discord.multi_bot.deciding_delay", {
        name: config.name,
        role: roleConfig.name
      });

      const aiDelay = await aiDecideObservationDelay(agent, roleConfig);
      roleConfig = { ...roleConfig, observationDelay: aiDelay };

      log("info", "discord.multi_bot.delay_decided", {
        name: config.name,
        role: roleConfig.name,
        delayMs: aiDelay,
        delaySec: (aiDelay / 1000).toFixed(1)
      });
    }

    // 创建Handler（传入AI决定的roleConfig）
    const handler = new DiscordBotHandler(config, agent, client, roleConfig);

    // 监听ready事件
    client.once("ready", () => {
      log("info", "discord.multi_bot.bot_ready", {
        name: config.name,
        agentId: config.agentId,
        user: client.user?.tag
      });
    });

    // 监听消息
    client.on("messageCreate", async (message: Message) => {
      try {
        await handler.handleMessage(message);
      } catch (error) {
        log("error", "discord.multi_bot.message_error", {
          name: config.name,
          error: String(error)
        });
      }
    });

    // 监听错误
    client.on("error", (error) => {
      log("error", "discord.multi_bot.client_error", {
        name: config.name,
        error: String(error)
      });
    });

    // 登录
    await client.login(config.token);

    log("info", "discord.multi_bot.bot_started", {
      name: config.name,
      agentId: config.agentId
    });

    return { client, handler };
  } catch (error) {
    log("error", "discord.multi_bot.bot_start_failed", {
      name: config.name,
      error: String(error)
    });
    return null;
  }
}

/**
 * 启动多个Discord Bots
 */
export async function startMultipleDiscordBots(
  configs: DiscordBotConfig[],
  agent: ChatEngine
): Promise<MultiBotStatus> {
  log("info", "discord.multi_bot.starting", { count: configs.length });

  const bots: MultiBotStatus["bots"] = [];
  const clients: Array<{ client: Client; handler: DiscordBotHandler }> = [];

  for (const config of configs) {
    const result = await startSingleBot(config, agent);

    if (result) {
      clients.push(result);
      bots.push({
        name: config.name || "unknown",
        agentId: config.agentId || "unknown",
        connected: true,
        user: result.client.user?.tag
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

  log("info", "discord.multi_bot.started", {
    total: configs.length,
    connected: clients.length,
    bots: bots.map(b => ({ name: b.name, agentId: b.agentId, connected: b.connected }))
  });

  // 优雅关闭处理
  process.on("SIGINT", async () => {
    log("info", "discord.multi_bot.shutting_down");

    for (const { client, handler } of clients) {
      handler.cleanup();
      await client.destroy();
    }

    log("info", "discord.multi_bot.shutdown_complete");
  });

  return { bots };
}

/**
 * 检测是否应该使用多Bot模式
 */
export function shouldUseMultiBotMode(
  config: DiscordBotConfig | DiscordBotConfig[] | undefined
): config is DiscordBotConfig[] {
  return Array.isArray(config) && config.length > 0;
}
