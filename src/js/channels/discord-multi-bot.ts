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
import { globalConfig } from "../shared/config-manager.js";
import fs from "node:fs";
import path from "node:path";

loadEnv();

// 【修复】配置文件路径
const BOT_ROLES_CONFIG_PATH = path.join(process.cwd(), "sessions", "bot-roles.json");

/**
 * 从文件加载已保存的角色配置
 */
function loadSavedRoleConfigs(): void {
  try {
    if (fs.existsSync(BOT_ROLES_CONFIG_PATH)) {
      const content = fs.readFileSync(BOT_ROLES_CONFIG_PATH, "utf-8");
      const data = JSON.parse(content);
      
      // 加载到 globalConfig
      for (const [key, value] of Object.entries(data)) {
        globalConfig.setConfig(key, value, "file");
      }

      log("info", "discord.multi_bot.config_loaded", {
        path: BOT_ROLES_CONFIG_PATH,
        keys: Object.keys(data).length
      });
    }
  } catch (error) {
    log("warn", "discord.multi_bot.config_load_failed", {
      path: BOT_ROLES_CONFIG_PATH,
      error: String(error)
    });
  }
}

/**
 * 保存角色配置到文件
 */
function saveRoleConfigsToFile(): void {
  try {
    // 收集所有 discord.bot.roles.* 配置
    const allConfigs = globalConfig.getAllConfigs();
    const roleConfigs: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(allConfigs)) {
      if (key.startsWith("discord.bot.roles.")) {
        roleConfigs[key] = value;
      }
    }

    // 确保目录存在
    const dir = path.dirname(BOT_ROLES_CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 写入文件
    fs.writeFileSync(
      BOT_ROLES_CONFIG_PATH,
      JSON.stringify(roleConfigs, null, 2),
      "utf-8"
    );

    log("info", "discord.multi_bot.config_saved", {
      path: BOT_ROLES_CONFIG_PATH,
      keys: Object.keys(roleConfigs).length
    });
  } catch (error) {
    log("error", "discord.multi_bot.config_save_failed", {
      path: BOT_ROLES_CONFIG_PATH,
      error: String(error)
    });
  }
}

// 【修复】监听配置变更，自动保存
let saveConfigTimeout: NodeJS.Timeout | null = null;
globalConfig.on("config-changed", (change) => {
  // 只关心 discord.bot.roles.* 配置
  if (change.path[0] === "discord" && 
      change.path[1] === "bot" && 
      change.path[2] === "roles") {
    
    // 防抖：延迟500ms保存，避免频繁写入
    if (saveConfigTimeout) {
      clearTimeout(saveConfigTimeout);
    }
    
    saveConfigTimeout = setTimeout(() => {
      saveRoleConfigsToFile();
      saveConfigTimeout = null;
    }, 500);
  }
});

export interface MultiBotStatus {
  bots: Array<{
    name: string;
    agentId: string;
    connected: boolean;
    user?: string;
    error?: string;
  }>;
}

const RECONNECT_INITIAL_DELAY_MS = 5000;
const RECONNECT_MAX_DELAY_MS = 300000; // 5 分钟

/**
 * 失败后按指数退避调度重连
 */
function scheduleReconnect(
  config: DiscordBotConfig,
  agent: ChatEngine,
  clients: Array<{ client: Client; handler: DiscordBotHandler }>,
  isShuttingDown: { value: boolean },
  delay: number,
  attempt: number
): void {
  const timer = setTimeout(async () => {
    if (isShuttingDown.value) return;

    log("info", "discord.multi_bot.bot_reconnecting", {
      name: config.name,
      agentId: config.agentId,
      attempt
    });

    const result = await startSingleBot(config, agent);

    if (result) {
      clients.push(result);
      log("info", "discord.multi_bot.bot_reconnected", {
        name: config.name,
        agentId: config.agentId,
        attempt,
        user: result.client.user?.tag
      });
    } else {
      if (isShuttingDown.value) return;
      const nextDelay = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS);
      log("warn", "discord.multi_bot.bot_reconnect_retry", {
        name: config.name,
        agentId: config.agentId,
        attempt,
        nextRetryMs: nextDelay,
        nextRetrySec: Math.round(nextDelay / 1000)
      });
      scheduleReconnect(config, agent, clients, isShuttingDown, nextDelay, attempt + 1);
    }
  }, delay);

  timer.unref();
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

    // 【修复】先尝试从持久化配置加载，只在没有保存值时才询问AI
    if (roleConfig.participationStrategy === "ai_decide") {
      // 【修复】先尝试从配置管理器加载已保存的延迟值
      const configKey = `discord.bot.roles.${agentId}.observationDelay`;
      const savedDelay = globalConfig.getConfig<number>(configKey);

      if (savedDelay !== undefined && savedDelay > 0) {
        // 使用已保存的延迟值
        roleConfig = { ...roleConfig, observationDelay: savedDelay };
        
        log("info", "discord.multi_bot.delay_loaded", {
          name: config.name,
          role: roleConfig.name,
          delayMs: savedDelay,
          delaySec: (savedDelay / 1000).toFixed(1),
          source: "config"
        });
      } else {
        // 没有保存的值，询问AI并保存
        log("info", "discord.multi_bot.deciding_delay", {
          name: config.name,
          role: roleConfig.name
        });

        const aiDelay = await aiDecideObservationDelay(agent, roleConfig);
        roleConfig = { ...roleConfig, observationDelay: aiDelay };

        // 【修复】持久化保存AI决定的延迟值
        globalConfig.setConfig(configKey, aiDelay, "override");

        log("info", "discord.multi_bot.delay_decided_and_saved", {
          name: config.name,
          role: roleConfig.name,
          delayMs: aiDelay,
          delaySec: (aiDelay / 1000).toFixed(1),
          configKey
        });
      }
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
  // 【修复】先加载已保存的角色配置
  loadSavedRoleConfigs();
  
  log("info", "discord.multi_bot.starting", { count: configs.length });

  const bots: MultiBotStatus["bots"] = [];
  const clients: Array<{ client: Client; handler: DiscordBotHandler }> = [];
  const isShuttingDown = { value: false };

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
      scheduleReconnect(config, agent, clients, isShuttingDown, RECONNECT_INITIAL_DELAY_MS, 1);
    }
  }

  log("info", "discord.multi_bot.started", {
    total: configs.length,
    connected: clients.length,
    bots: bots.map(b => ({ name: b.name, agentId: b.agentId, connected: b.connected }))
  });

  // 优雅关闭处理
  process.on("SIGINT", async () => {
    isShuttingDown.value = true;
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
