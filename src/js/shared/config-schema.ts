import { z } from "zod";

/**
 * 配置验证 Schema（使用 Zod）
 * 提供类型安全和运行时验证
 */

// 提供商类型
const ProviderTypeSchema = z.enum(["openai", "anthropic"]);

// 提供商配置
const ProviderConfigSchema = z.object({
  type: ProviderTypeSchema,
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  authHeader: z.string().optional(),
  authScheme: z.string().optional(),
  model: z.string().optional(),
  apiVersion: z.string().optional(),
  alwaysThinkingEnabled: z.boolean().optional()
}).refine(
  (data) => {
    // Anthropic 需要 apiKey，且不能为空
    if (data.type === "anthropic" && (!data.apiKey || data.apiKey.trim().length === 0)) {
      return false;
    }
    // 如果提供了 baseUrl，必须是有效的 URL
    if (data.baseUrl && data.baseUrl.trim().length > 0) {
      try {
        new URL(data.baseUrl);
      } catch {
        return false;
      }
    }
    return true;
  },
  {
    message: "Provider 配置验证失败：Anthropic 需要有效的 API Key，baseUrl 必须是有效的 URL",
    path: []
  }
);

// 频道配置基础类型
const ChannelConfigBaseSchema = z.object({
  enabled: z.boolean(),
  token: z.string().optional(),
  appId: z.string().optional(),
  appSecret: z.string().optional(),
  verificationToken: z.string().optional(),
  encryptKey: z.string().optional()
});

// Discord Bot 配置（支持多个）
const DiscordBotConfigSchema = ChannelConfigBaseSchema.extend({
  name: z.string().optional(), // bot 名称，用于区分不同的 bot
  channels: z.array(z.string()).optional(), // 监听的频道 ID 列表
  agentId: z.string().optional() // bot 专属的 agent ID（固定角色）
});

// Telegram 频道配置（单 bot 模式）
const TelegramChannelConfigSchema = ChannelConfigBaseSchema.extend({
  proxyUrl: z.string().optional() // Telegram API 代理地址
});

// Telegram Bot 配置（多 bot 模式，对标 DiscordBotConfigSchema）
const TelegramBotConfigSchema = ChannelConfigBaseSchema.extend({
  name: z.string().optional(), // bot 名称，用于区分不同的 bot
  agentId: z.string().optional(), // bot 专属的 agent ID（固定角色）
  proxyUrl: z.string().optional() // Telegram API 代理地址
});

// 企业微信频道配置
const WecomChannelConfigSchema = ChannelConfigBaseSchema.extend({
  corpId: z.string().optional(),
  agentId: z.string().optional(),
  encodingAesKey: z.string().optional(),
  callbackDomain: z.string().optional()
});

// 频道配置
const ChannelsConfigSchema = z.object({
  discord: z.union([
    ChannelConfigBaseSchema, // 向后兼容：单个 bot 配置
    z.array(DiscordBotConfigSchema) // 新功能：多个 bot 配置
  ]).optional(),
  feishu: ChannelConfigBaseSchema.optional(),
  wecom: WecomChannelConfigSchema.optional(),
  telegram: z.union([
    TelegramChannelConfigSchema, // 向后兼容：单个 bot 配置
    z.array(TelegramBotConfigSchema) // 新功能：多个 bot 配置
  ]).optional()
});

// IP 地址验证正则
const IP_REGEX = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

// 网关配置
const GatewayConfigSchema = z.object({
  host: z.string().refine(
    (val) => IP_REGEX.test(val) || val === "localhost",
    { message: "必须是有效的 IP 地址或 localhost" }
  ),
  port: z.number()
    .int("端口号必须是整数")
    .min(1, "端口号必须大于 0")
    .max(65535, "端口号不能超过 65535")
});

// 主配置
export const JPClawConfigSchema = z.object({
  providers: z.array(ProviderConfigSchema), // 移除 min(1)，允许从环境变量加载
  channels: ChannelsConfigSchema,
  gateway: GatewayConfigSchema,
  dataDir: z.string()
});

// 导出类型
export type JPClawConfig = z.infer<typeof JPClawConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ChannelConfig = z.infer<typeof ChannelConfigBaseSchema>;
export type DiscordBotConfig = z.infer<typeof DiscordBotConfigSchema>;
export type WecomChannelConfig = z.infer<typeof WecomChannelConfigSchema>;
export type TelegramChannelConfig = z.infer<typeof TelegramChannelConfigSchema>;
export type TelegramBotConfig = z.infer<typeof TelegramBotConfigSchema>;

/**
 * 验证配置并返回友好的错误信息
 */
export function validateConfig(config: unknown): {
  success: true;
  data: JPClawConfig
} | {
  success: false;
  errors: string[]
} {
  const result = JPClawConfigSchema.safeParse(config);

  if (result.success) {
    return { success: true, data: result.data };
  }

  // 格式化错误信息
  const errors = result.error.issues.map((err: any) => {
    const path = err.path.join(".");
    return `配置错误 [${path}]: ${err.message}`;
  });

  return { success: false, errors };
}

/**
 * 验证环境变量配置
 */
export function validateEnvConfig(env: NodeJS.ProcessEnv): {
  success: true;
} | {
  success: false;
  errors: string[];
} {
  const errors: string[] = [];

  // 检查至少有一个提供商配置
  const hasAnthropic = !!env.ANTHROPIC_AUTH_TOKEN;
  const hasOpenAI = !!env.OPENAI_API_KEY;

  if (!hasAnthropic && !hasOpenAI) {
    errors.push("至少需要配置一个 AI 提供商（ANTHROPIC_AUTH_TOKEN 或 OPENAI_API_KEY）");
  }

  // 验证 Anthropic 配置
  if (hasAnthropic) {
    if (env.ANTHROPIC_BASE_URL && !isValidUrl(env.ANTHROPIC_BASE_URL)) {
      errors.push("ANTHROPIC_BASE_URL 必须是有效的 URL");
    }
  }

  // 验证 OpenAI 配置
  if (hasOpenAI) {
    if (env.OPENAI_BASE_URL && !isValidUrl(env.OPENAI_BASE_URL)) {
      errors.push("OPENAI_BASE_URL 必须是有效的 URL");
    }
  }

  // 验证网关端口
  if (env.JPCLAW_GATEWAY_PORT) {
    const port = Number(env.JPCLAW_GATEWAY_PORT);
    if (isNaN(port) || port < 1 || port > 65535) {
      errors.push("JPCLAW_GATEWAY_PORT 必须是 1-65535 之间的整数");
    }
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return { success: true };
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
