/**
 * LLM 网关客户端（litellm proxy）
 *
 * 统一封装大模型网关的调用，支持：
 * - 文本对话（Chat Completions）
 * - 图片理解（Vision）
 * - 语音转录（Whisper）
 * - 文本转语音（TTS）
 *
 * 配置化设计，支持环境变量覆盖
 */

import { log } from "../shared/logger.js";

/**
 * 网关配置
 */
export interface GatewayConfig {
  /** 网关基础 URL */
  baseUrl?: string;

  /** API 密钥 */
  apiKey?: string;

  /** 默认模型 */
  defaultModel?: string;

  /** 请求超时时间（毫秒） */
  timeout?: number;
}

/**
 * 消息内容块（支持文本和图片）
 */
export type MessageContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * 聊天消息
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | MessageContent[];
}

/**
 * 聊天请求参数
 */
export interface ChatCompletionRequest {
  /** 模型名称（可选，默认使用配置的 defaultModel） */
  model?: string;

  /** 消息列表 */
  messages: ChatMessage[];

  /** 最大生成 tokens */
  max_tokens?: number;

  /** 温度参数 */
  temperature?: number;

  /** 其他参数 */
  [key: string]: any;
}

/**
 * 聊天响应
 */
export interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * LLM 网关客户端
 */
export class LLMGatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly timeout: number;

  constructor(config: GatewayConfig = {}) {
    // 优先使用传入的配置，其次使用环境变量，最后使用默认值
    this.baseUrl =
      config.baseUrl ||
      process.env.LLM_GATEWAY_BASE_URL ||
      "https://llm-guard.mininglamp.com";

    // P0-NEW-1修复: 删除硬编码API密钥，强制从环境变量读取
    this.apiKey =
      config.apiKey ||
      process.env.LLM_GATEWAY_API_KEY ||
      "";

    if (!this.apiKey) {
      log("warn", "llm.gateway.no_api_key", {
        message: "LLM_GATEWAY_API_KEY not configured, API calls will fail"
      });
    }

    this.defaultModel = config.defaultModel || process.env.LLM_GATEWAY_MODEL || "gpt-4o";

    // P0-NEW-4修复: 超时值解析添加范围检查
    const rawTimeout = config.timeout || Number(process.env.LLM_GATEWAY_TIMEOUT || "30000");
    this.timeout = Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(Math.max(rawTimeout, 1000), 300000) // 最小1秒，最大5分钟
      : 30000; // 默认30秒

    log("info", "llm.gateway.initialized", {
      baseUrl: this.baseUrl,
      defaultModel: this.defaultModel,
      timeout: this.timeout,
      hasApiKey: !!this.apiKey
    });
  }

  /**
   * 调用聊天完成 API
   */
  async chatCompletion(
    request: ChatCompletionRequest
  ): Promise<ChatCompletionResponse | null> {
    try {
      const model = request.model || this.defaultModel;

      log("info", "llm.gateway.chat.request", {
        model,
        messageCount: request.messages.length
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          ...request,
          model
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        log("error", "llm.gateway.chat.error", {
          status: response.status,
          statusText: response.statusText,
          model
        });
        return null;
      }

      const data = (await response.json()) as ChatCompletionResponse;

      log("info", "llm.gateway.chat.success", {
        model,
        tokensUsed: data.usage?.total_tokens || 0
      });

      return data;
    } catch (error) {
      log("error", "llm.gateway.chat.exception", {
        error: String(error),
        model: request.model || this.defaultModel
      });
      return null;
    }
  }

  /**
   * 理解图片内容（Vision API）
   *
   * @param imageUrl - 图片 URL
   * @param prompt - 提示词（可选，默认为通用描述）
   * @param model - 模型名称（可选，默认使用配置的 defaultModel）
   * @returns 图片描述
   */
  async understandImage(
    imageUrl: string,
    prompt?: string,
    model?: string
  ): Promise<string | null> {
    const actualPrompt =
      prompt || "请详细描述这张图片的内容。如果图片中有文字，请识别并提取出来。";

    const response = await this.chatCompletion({
      model: model || this.defaultModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: actualPrompt },
            { type: "image_url", image_url: { url: imageUrl } }
          ]
        }
      ],
      max_tokens: 1000
    });

    return response?.choices?.[0]?.message?.content || null;
  }

  /**
   * 简单文本对话
   *
   * @param prompt - 用户提示
   * @param model - 模型名称（可选）
   * @returns AI 回复
   */
  async chat(prompt: string, model?: string): Promise<string | null> {
    const response = await this.chatCompletion({
      model,
      messages: [{ role: "user", content: prompt }]
    });

    return response?.choices?.[0]?.message?.content || null;
  }
}

/**
 * 单例模式：默认网关客户端
 */
let defaultClient: LLMGatewayClient | null = null;

/**
 * 获取默认网关客户端（单例）
 */
export function getDefaultGatewayClient(): LLMGatewayClient {
  if (!defaultClient) {
    defaultClient = new LLMGatewayClient();
  }
  return defaultClient;
}

/**
 * 重置默认客户端（用于测试或重新配置）
 */
export function resetDefaultGatewayClient(config?: GatewayConfig): void {
  defaultClient = config ? new LLMGatewayClient(config) : null;
}
