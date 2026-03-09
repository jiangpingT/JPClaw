import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./env.js";
import { JPClawConfigSchema, validateConfig, validateEnvConfig } from "./config-schema.js";
import type { JPClawConfig, ProviderConfig, ChannelConfig, DiscordBotConfig, WecomChannelConfig, TelegramChannelConfig, TelegramBotConfig, DmworkBotConfig } from "./config-schema.js";
import { JPClawError, ErrorCode } from "./errors.js";

// 重新导出类型
export type { JPClawConfig, ProviderConfig, ChannelConfig, DiscordBotConfig, WecomChannelConfig, TelegramChannelConfig, TelegramBotConfig, DmworkBotConfig };

const DEFAULT_CONFIG: JPClawConfig = {
  providers: [],
  channels: {},
  gateway: {
    host: "0.0.0.0",
    port: 18790
  },
  dataDir: "sessions"
};

export function resolveConfigPath(): string {
  const envPath = process.env.JPCLAW_CONFIG;
  if (envPath) return envPath;
  return path.resolve(process.cwd(), "sessions", "jpclaw.json");
}

export function loadConfig(): JPClawConfig {
  loadEnv();

  // 验证环境变量配置
  const envValidation = validateEnvConfig(process.env);
  if (!envValidation.success) {
    console.error("\n❌ 环境变量配置错误：\n");
    envValidation.errors.forEach((err) => console.error(`  • ${err}`));
    console.error("\n💡 建议:");
    console.error("  • 检查 .env 文件中的配置项");
    console.error("  • 参考 .env.example 文件查看配置示例\n");

    throw new JPClawError({
      code: ErrorCode.SYSTEM_CONFIG_INVALID,
      message: "环境变量配置验证失败",
      userMessage: "配置错误，请检查 .env 文件",
      context: { errors: envValidation.errors }
    });
  }

  const filePath = resolveConfigPath();
  let baseConfig = { ...DEFAULT_CONFIG };

  // 加载配置文件（如果存在）
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      baseConfig = { ...DEFAULT_CONFIG, ...parsed };
    } catch (error) {
      console.error(`\n❌ 配置文件解析失败: ${filePath}`);
      console.error(error instanceof Error ? error.message : String(error));
      console.error("\n💡 建议:");
      console.error("  • 检查 JSON 格式是否正确");
      console.error("  • 使用 JSON 验证工具检查文件\n");

      throw new JPClawError({
        code: ErrorCode.SYSTEM_CONFIG_INVALID,
        message: `配置文件解析失败: ${filePath}`,
        userMessage: "配置文件格式错误",
        context: { filePath },
        cause: error instanceof Error ? error : undefined
      });
    }
  }

  // 合并环境变量
  const config = mergeEnv(baseConfig);

  // 验证最终配置
  const validation = validateConfig(config);
  if (!validation.success) {
    console.error("\n❌ 配置验证失败：\n");
    validation.errors.forEach((err) => console.error(`  • ${err}`));
    console.error("\n💡 建议:");
    console.error("  • 确保所有必需的配置项都已设置");
    console.error("  • 检查配置值的格式和范围\n");

    throw new JPClawError({
      code: ErrorCode.SYSTEM_CONFIG_INVALID,
      message: "配置验证失败",
      userMessage: "配置不完整或格式错误",
      context: { errors: validation.errors }
    });
  }

  // 额外验证：确保至少有一个提供商
  if (validation.data.providers.length === 0) {
    console.error("\n❌ 配置错误：没有配置任何 AI 提供商\n");
    console.error("💡 建议:");
    console.error("  • 在 .env 文件中设置 ANTHROPIC_AUTH_TOKEN 或 OPENAI_API_KEY\n");

    throw new JPClawError({
      code: ErrorCode.SYSTEM_CONFIG_INVALID,
      message: "没有配置任何 AI 提供商",
      userMessage: "请至少配置一个 AI 提供商（Anthropic 或 OpenAI）",
      context: { providersCount: 0 }
    });
  }

  return validation.data;
}

export function writeConfig(config: JPClawConfig): void {
  const filePath = resolveConfigPath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
}

function mergeEnv(config: JPClawConfig): JPClawConfig {
  const providers = [...config.providers];
  const channels = { ...config.channels };

  // Anthropic 优先作为主要提供商
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    providers.push({
      type: "anthropic",
      apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      authHeader: process.env.ANTHROPIC_AUTH_HEADER || "x-api-key",
      authScheme: process.env.ANTHROPIC_AUTH_SCHEME || "",
      model: process.env.ANTHROPIC_MODEL,
      apiVersion: process.env.ANTHROPIC_VERSION || "2023-06-01",
      alwaysThinkingEnabled: parseBoolean(process.env.ANTHROPIC_ALWAYS_THINKING)
    });
  }

  if (process.env.OPENAI_API_KEY) {
    providers.push({
      type: "openai",
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL,
      authHeader: process.env.OPENAI_AUTH_HEADER || "Authorization",
      authScheme: process.env.OPENAI_AUTH_SCHEME || "Bearer",
      model: process.env.OPENAI_MODEL
    });
  }

  return {
    ...config,
    providers,
    channels: mergeChannelEnv(channels)
  };
}

function parseBoolean(value?: string): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function mergeChannelEnv(channels: JPClawConfig["channels"]): JPClawConfig["channels"] {
  const next = { ...channels };

  // Discord 多 bot 支持
  const discordBots: any[] = [];

  // 检测所有 DISCORD_BOTx_TOKEN 环境变量
  const botTokenPattern = /^DISCORD_BOT(\d+)_TOKEN$/;
  const botNumbers = new Set<number>();

  for (const key in process.env) {
    const match = key.match(botTokenPattern);
    if (match) {
      botNumbers.add(parseInt(match[1]));
    }
  }

  // 如果有编号的 bot，使用数组形式
  if (botNumbers.size > 0) {
    for (const num of Array.from(botNumbers).sort((a, b) => a - b)) {
      const token = process.env[`DISCORD_BOT${num}_TOKEN`];
      const name = process.env[`DISCORD_BOT${num}_NAME`] || `bot${num}`;
      const channelsStr = process.env[`DISCORD_BOT${num}_CHANNELS`];
      const agentId = process.env[`DISCORD_BOT${num}_AGENT`]; // 读取bot专属的agent

      if (token) {
        discordBots.push({
          enabled: true,
          token,
          name,
          channels: channelsStr ? channelsStr.split(",").map(id => id.trim()) : undefined,
          agentId: agentId || undefined // 添加agentId配置
        });
      }
    }

    if (discordBots.length > 0) {
      next.discord = discordBots;
    }
  }
  // 向后兼容：支持单个 DISCORD_BOT_TOKEN
  else if (process.env.DISCORD_BOT_TOKEN) {
    next.discord = {
      enabled: true,
      token: process.env.DISCORD_BOT_TOKEN
    };
  }

  if (process.env.FEISHU_APP_ID || process.env.FEISHU_APP_SECRET) {
    next.feishu = {
      enabled: true,
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
      encryptKey: process.env.FEISHU_ENCRYPT_KEY
    };
  }

  const wecomEnabled = parseBoolean(process.env.WECOM_ENABLED);
  if (
    wecomEnabled === true ||
    process.env.WECOM_CORP_ID ||
    process.env.WECOM_AGENT_ID ||
    process.env.WECOM_APP_SECRET
  ) {
    next.wecom = {
      enabled: wecomEnabled ?? true,
      corpId: process.env.WECOM_CORP_ID,
      agentId: process.env.WECOM_AGENT_ID,
      appSecret: process.env.WECOM_APP_SECRET,
      token: process.env.WECOM_TOKEN,
      encodingAesKey: process.env.WECOM_ENCODING_AES_KEY,
      callbackDomain: process.env.WECOM_CALLBACK_DOMAIN
    };
  }

  // Telegram 多 bot 支持（对标 Discord 的多 bot 模式）
  const telegramBots: any[] = [];
  const telegramBotTokenPattern = /^TELEGRAM_BOT(\d+)_TOKEN$/;
  const telegramBotNumbers = new Set<number>();

  for (const key in process.env) {
    const match = key.match(telegramBotTokenPattern);
    if (match) {
      telegramBotNumbers.add(parseInt(match[1]));
    }
  }

  if (telegramBotNumbers.size > 0) {
    const proxyUrl = process.env.TELEGRAM_PROXY_URL;

    for (const num of Array.from(telegramBotNumbers).sort((a, b) => a - b)) {
      const token = process.env[`TELEGRAM_BOT${num}_TOKEN`];
      const name = process.env[`TELEGRAM_BOT${num}_NAME`] || `bot${num}`;
      const agentId = process.env[`TELEGRAM_BOT${num}_AGENT`];

      if (token) {
        telegramBots.push({
          enabled: true,
          token,
          name,
          agentId: agentId || undefined,
          proxyUrl: proxyUrl || undefined
        });
      }
    }

    if (telegramBots.length > 0) {
      next.telegram = telegramBots;
    }
  }
  // 向后兼容：支持单个 TELEGRAM_BOT_TOKEN
  else if (process.env.TELEGRAM_BOT_TOKEN) {
    next.telegram = {
      enabled: true,
      token: process.env.TELEGRAM_BOT_TOKEN,
      proxyUrl: process.env.TELEGRAM_PROXY_URL
    };
  }

  // DMWork 多 bot 支持
  const dmworkBots: any[] = [];
  const dmworkBotTokenPattern = /^DMWORK_BOT(\d+)_TOKEN$/;
  const dmworkBotNumbers = new Set<number>();

  for (const key in process.env) {
    const match = key.match(dmworkBotTokenPattern);
    if (match) dmworkBotNumbers.add(parseInt(match[1]));
  }

  if (dmworkBotNumbers.size > 0) {
    const wsUrl = process.env.DMWORK_WS_URL || "wss://im-test.xming.ai/ws";
    const apiUrl = process.env.DMWORK_API_URL || "https://im-test.xming.ai/api";
    const ownerUid = process.env.DMWORK_OWNER_UID || "";

    for (const num of Array.from(dmworkBotNumbers).sort((a, b) => a - b)) {
      const botToken = process.env[`DMWORK_BOT${num}_TOKEN`];
      const robotId = process.env[`DMWORK_BOT${num}_ROBOT_ID`];
      const imToken = process.env[`DMWORK_BOT${num}_IM_TOKEN`];
      const name = process.env[`DMWORK_BOT${num}_NAME`] || `dmbot${num}`;
      const agentId = process.env[`DMWORK_BOT${num}_AGENT`];

      if (botToken && robotId && imToken) {
        dmworkBots.push({
          enabled: true,
          botToken,
          robotId,
          imToken,
          wsUrl,
          apiUrl,
          ownerUid,
          name,
          agentId: agentId || undefined,
        });
      }
    }

    if (dmworkBots.length > 0) {
      next.dmwork = dmworkBots;
    }
  }
  // 向后兼容：支持单个 DMWORK_BOT_TOKEN
  else if (process.env.DMWORK_BOT_TOKEN && process.env.DMWORK_IM_TOKEN) {
    next.dmwork = {
      enabled: true,
      botToken: process.env.DMWORK_BOT_TOKEN,
      robotId: process.env.DMWORK_ROBOT_ID || "jpclaw_bot",
      imToken: process.env.DMWORK_IM_TOKEN,
      wsUrl: process.env.DMWORK_WS_URL || "wss://im-test.xming.ai/ws",
      apiUrl: process.env.DMWORK_API_URL || "https://im-test.xming.ai/api",
      ownerUid: process.env.DMWORK_OWNER_UID || "",
      agentId: process.env.DMWORK_AGENT_ID,
      name: process.env.DMWORK_NAME || "jpclaw",
    };
  }

  return next;
}
