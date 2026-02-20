/**
 * Telegram 集成模块 - 智能路由到单 Bot 或多 Bot 系统
 *
 * 自动检测配置类型：
 * - 如果是单个 bot 配置 → 使用传统系统（向后兼容）
 * - 如果是多个 bot 配置 → 使用新的无状态协作系统
 */

import TelegramBot from "node-telegram-bot-api";
import type { TelegramChannelConfig, TelegramBotConfig } from "../shared/config.js";
import type { ChatEngine } from "../core/engine.js";
import { log } from "../shared/logger.js";
import { splitTextIntoChunks, resolveMessageChunkLimit } from "../shared/text-chunk.js";
import {
  startMultipleTelegramBots,
  shouldUseTelegramMultiBotMode,
  type TelegramMultiBotStatus
} from "./telegram-multi-bot.js";

// Telegram 单条消息上限 4096 字符，留余量用 4000
const TELEGRAM_MESSAGE_LIMIT = resolveMessageChunkLimit("telegram", 4000);
const DEDUPE_WINDOW_MS = Number(process.env.TELEGRAM_DEDUPE_WINDOW_MS || "3000");
const MAX_INFLIGHT_REQUESTS = Number(process.env.TELEGRAM_MAX_INFLIGHT_REQUESTS || "50");
const SEND_TIMEOUT_MS = Number(process.env.TELEGRAM_SEND_TIMEOUT_MS || "30000");

export type TelegramStatus = {
  enabled: boolean;
  connected: boolean;
  attempts: number;
  retryInMs: number | null;
  user?: string;
  lastError?: string;
};

export type TelegramRuntime = {
  getStatus: () => TelegramStatus;
  stop: () => void;
};

/**
 * 智能启动 Telegram 渠道
 * 根据配置自动选择单 Bot 或多 Bot 模式
 */
export function startTelegramChannel(
  config: TelegramChannelConfig | TelegramBotConfig | TelegramBotConfig[] | undefined,
  agent: ChatEngine
): TelegramRuntime {
  // 检测是否是多 Bot 模式
  if (shouldUseTelegramMultiBotMode(config)) {
    log("info", "telegram.mode.multi_bot", {
      count: config.length,
      bots: config.map(c => ({ name: c.name, agentId: c.agentId }))
    });

    // 启动多 Bot 模式（异步，但不阻塞）
    void startMultipleTelegramBots(config, agent);

    // 返回一个兼容的 runtime 对象
    return createMultiBotRuntime(config);
  }

  // 单 Bot 模式：使用传统系统
  log("info", "telegram.mode.single_bot");
  return startSingleTelegramBot(config as TelegramChannelConfig | undefined, agent);
}

/**
 * 为多 Bot 模式创建兼容的 Runtime 对象
 */
function createMultiBotRuntime(configs: TelegramBotConfig[]): TelegramRuntime {
  const status: TelegramStatus = {
    enabled: configs.some(c => c.enabled),
    connected: false,
    attempts: 0,
    retryInMs: null
  };

  return {
    getStatus: () => ({ ...status }),
    stop: () => {
      log("info", "telegram.multi_bot.stop_requested");
    }
  };
}

/**
 * 启动单个 Telegram Bot（传统模式，向后兼容）
 */
function startSingleTelegramBot(
  config: TelegramChannelConfig | undefined,
  agent: ChatEngine
): TelegramRuntime {
  const status: TelegramStatus = {
    enabled: Boolean(config?.enabled && config?.token),
    connected: false,
    attempts: 0,
    retryInMs: null
  };

  if (!config?.enabled || !config.token) {
    log("info", "telegram.disabled");
    return {
      getStatus: () => ({ ...status }),
      stop: () => {}
    };
  }

  const token = config.token;
  const proxyUrl = config.proxyUrl || process.env.HTTPS_PROXY;

  // 去重 Map：dedupeKey -> timestamp
  const recentMessages = new Map<string, number>();
  // 背压控制
  const inFlightRequests = new Map<string, { startedAt: number }>();

  let bot: TelegramBot | null = null;
  let stopped = false;
  let retryCount = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const RETRY_BASE_MS = 2_000;
  const RETRY_MAX_MS = 60_000;

  // 定期清理去重记录和过期 inflight
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, ts] of recentMessages) {
      if (now - ts > DEDUPE_WINDOW_MS * 10) {
        recentMessages.delete(key);
      }
    }
    for (const [key, val] of inFlightRequests) {
      if (now - val.startedAt > 10 * 60 * 1000) {
        inFlightRequests.delete(key);
      }
    }
  }, 60_000);
  cleanupInterval.unref();

  function buildDedupeKey(chatId: number, userId: number, text: string): string {
    const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
    const timeWindow = Math.floor(Date.now() / DEDUPE_WINDOW_MS);
    return `${chatId}::${userId}::${timeWindow}::${normalized}`;
  }

  function scheduleReconnect(reason: string): void {
    if (stopped || retryTimer) return;
    retryCount += 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (retryCount - 1), RETRY_MAX_MS);
    status.retryInMs = delay;
    log("warn", "telegram.reconnect.scheduled", { reason, delay, retryCount });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delay);
  }

  async function sendReply(
    chatId: number,
    text: string,
    replyToMessageId?: number
  ): Promise<void> {
    const chunks = splitTextIntoChunks(text.trim() || "已处理完成。", {
      maxLength: TELEGRAM_MESSAGE_LIMIT
    });

    for (const chunk of chunks) {
      if (!bot) break;
      try {
        await withTimeout(
          bot.sendMessage(chatId, chunk, {
            reply_to_message_id: replyToMessageId,
            parse_mode: "Markdown"
          }),
          SEND_TIMEOUT_MS
        );
      } catch (markdownError) {
        // Markdown 解析失败时回退到纯文本
        try {
          await withTimeout(
            bot.sendMessage(chatId, chunk, {
              reply_to_message_id: replyToMessageId
            }),
            SEND_TIMEOUT_MS
          );
        } catch (plainError) {
          log("error", "telegram.send.failed", {
            chatId,
            error: String(plainError)
          });
        }
      }
      // 第一条之后不需要 reply_to
      replyToMessageId = undefined;
    }
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    status.attempts += 1;
    status.retryInMs = null;
    status.connected = false;

    // 销毁旧实例
    if (bot) {
      try {
        bot.stopPolling();
      } catch {
        // ignore
      }
      bot = null;
    }

    log("info", "telegram.connecting", { attempt: status.attempts });

    try {
      // 构建 polling 选项
      const pollingOptions: TelegramBot.ConstructorOptions = {
        polling: true
      };

      // 代理支持：通过 request 选项配置
      if (proxyUrl) {
        pollingOptions.request = {
          proxy: proxyUrl
        } as any;
        log("info", "telegram.proxy.enabled", {
          proxyUrl: maskUrl(proxyUrl)
        });
      }

      bot = new TelegramBot(token, pollingOptions);

      // 获取 bot 信息
      const me = await bot.getMe();
      status.connected = true;
      status.retryInMs = null;
      status.user = `@${me.username}`;
      status.lastError = undefined;
      retryCount = 0;

      log("info", "telegram.ready", {
        user: status.user,
        botId: me.id,
        firstName: me.first_name
      });

      // 监听消息
      bot.on("message", async (msg) => {
        try {
          await handleMessage(msg);
        } catch (error) {
          log("error", "telegram.message.unhandled", {
            chatId: msg.chat.id,
            error: String(error)
          });
        }
      });

      // 监听 polling 错误
      bot.on("polling_error", (error) => {
        const errorMsg = String(error);
        status.lastError = errorMsg;

        // ETELEGRAM 409 冲突：其他实例在 polling
        if (errorMsg.includes("409")) {
          log("error", "telegram.polling.conflict", {
            error: errorMsg,
            hint: "另一个 bot 实例可能在运行中"
          });
        } else {
          log("error", "telegram.polling.error", { error: errorMsg });
        }

        // 严重错误时重连
        if (
          errorMsg.includes("EFATAL") ||
          errorMsg.includes("ECONNRESET") ||
          errorMsg.includes("ENOTFOUND")
        ) {
          status.connected = false;
          scheduleReconnect("polling_fatal_error");
        }
      });
    } catch (error) {
      status.connected = false;
      status.lastError = String(error);
      log("error", "telegram.connect.failed", { error: String(error) });
      scheduleReconnect("connect_failed");
    }
  }

  async function handleMessage(msg: TelegramBot.Message): Promise<void> {
    // 过滤 bot 消息
    if (msg.from?.is_bot) return;

    // 提取文本内容（消息文本 或 图片/文件 caption）
    const text = (msg.text || msg.caption || "").trim();
    if (!text) return;

    const chatId = msg.chat.id;
    const userId = msg.from?.id || 0;
    const userName =
      msg.from?.username ||
      [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") ||
      "unknown";
    const messageId = msg.message_id;

    // 去重检查
    const dedupeKey = buildDedupeKey(chatId, userId, text);
    const lastSeen = recentMessages.get(dedupeKey);
    if (lastSeen && Date.now() - lastSeen <= DEDUPE_WINDOW_MS) {
      log("info", "telegram.message.deduped", { chatId, userId });
      return;
    }
    recentMessages.set(dedupeKey, Date.now());

    // 背压控制
    if (inFlightRequests.size >= MAX_INFLIGHT_REQUESTS) {
      log("warn", "telegram.message.queue_full", {
        chatId,
        userId,
        inFlightCount: inFlightRequests.size
      });
      await sendReply(chatId, "系统负载过高，请稍后再试。", messageId);
      return;
    }

    const inflightKey = `${chatId}::${messageId}`;
    inFlightRequests.set(inflightKey, { startedAt: Date.now() });

    log("info", "telegram.message.received", {
      chatId,
      userId,
      userName,
      textLength: text.length,
      inFlightCount: inFlightRequests.size
    });

    try {
      // 发送"正在输入"状态
      if (bot) {
        bot.sendChatAction(chatId, "typing").catch(() => {});
      }

      const replyContext = {
        userId: String(userId),
        userName,
        channelId: `telegram:${chatId}`
      };

      const output = await agent.reply(text, replyContext);
      const cleaned = (output || "").trim();
      const finalText = cleaned || "已处理完成，但没有可返回内容。";

      await sendReply(chatId, finalText, messageId);

      log("info", "telegram.reply.sent", {
        chatId,
        userId,
        outputLength: finalText.length
      });
    } catch (error) {
      log("error", "telegram.reply.error", {
        chatId,
        userId,
        error: String(error)
      });
      await sendReply(
        chatId,
        "抱歉，我这次处理失败了，请稍后再试。",
        messageId
      );
    } finally {
      inFlightRequests.delete(inflightKey);
    }
  }

  function stop(): void {
    stopped = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    clearInterval(cleanupInterval);
    if (bot) {
      try {
        bot.stopPolling();
      } catch {
        // ignore
      }
      bot = null;
    }
    status.connected = false;
    log("info", "telegram.stopped");
  }

  // 启动连接
  void connect();

  return {
    getStatus: () => ({ ...status }),
    stop
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Telegram operation timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
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
