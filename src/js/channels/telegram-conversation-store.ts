/**
 * Telegram 共享对话存储
 *
 * 替代 Discord 的 getRecentChannelHistory()，
 * 所有 bot 跑在同一个 Node.js 进程，共享一个 Map<chatId, messages[]>。
 * 输出格式与 bot-roles.ts 的 formatConversationHistory() 兼容。
 */

import { log } from "../shared/logger.js";

export interface StoredMessage {
  author: string;
  content: string;
  isBot: boolean;
  timestamp: Date;
  /** 触发消息的 message_id（用于观察窗口过滤和去重） */
  messageId?: number;
  /** 是否是用户对其他消息的回复（非新问题） */
  isReply?: boolean;
}

export class ConversationStore {
  private store = new Map<string, StoredMessage[]>();

  /** 消息过期时间（毫秒） */
  private readonly expiryMs: number;
  /** 每个 chat 最多保留的消息数 */
  private readonly maxMessagesPerChat: number;
  /** 定期清理定时器 */
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(options?: { expiryMs?: number; maxMessagesPerChat?: number; cleanupIntervalMs?: number }) {
    this.expiryMs = options?.expiryMs ?? 10 * 60 * 1000; // 默认 10 分钟
    this.maxMessagesPerChat = options?.maxMessagesPerChat ?? 50;
    const cleanupIntervalMs = options?.cleanupIntervalMs ?? 60_000; // 默认 60 秒

    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  /**
   * 记录一条消息
   */
  recordMessage(
    chatId: string | number,
    author: string,
    content: string,
    isBot: boolean,
    messageId?: number,
    isReply?: boolean
  ): void {
    const key = String(chatId);
    let messages = this.store.get(key);

    if (!messages) {
      messages = [];
      this.store.set(key, messages);
    }

    // messageId 去重：多个 handler 共享同一个 store，避免重复记录
    if (messageId !== undefined && messages.some(msg => msg.messageId === messageId)) {
      return;
    }

    messages.push({
      author,
      content,
      isBot,
      timestamp: new Date(),
      messageId,
      isReply
    });

    // 超过上限时裁剪最早的消息
    if (messages.length > this.maxMessagesPerChat) {
      messages.splice(0, messages.length - this.maxMessagesPerChat);
    }
  }

  /**
   * 获取对话历史
   *
   * @param chatId - 聊天 ID
   * @param limit - 最多返回条数
   * @param sinceMessageId - 可选：从这条消息开始（包含），排除之后的新用户问题
   */
  getHistory(
    chatId: string | number,
    limit: number = 10,
    sinceMessageId?: number
  ): StoredMessage[] {
    const key = String(chatId);
    const messages = this.store.get(key);

    if (!messages || messages.length === 0) {
      return [];
    }

    const now = Date.now();

    // 过滤过期消息
    let valid = messages.filter(msg => now - msg.timestamp.getTime() < this.expiryMs);

    if (sinceMessageId !== undefined) {
      // 找到触发消息的索引
      const sinceIndex = valid.findIndex(msg => msg.messageId === sinceMessageId);

      if (sinceIndex !== -1) {
        // 从触发消息开始，过滤后续的新用户问题（保留 bot 回复、用户回复和触发消息本身）
        // 对标 Discord getRecentChannelHistory 的行为：
        //   - 排除触发消息之前的消息
        //   - 保留触发消息本身
        //   - 排除新用户问题（非回复的用户消息）
        //   - 保留用户回复（isReply=true 的用户消息）
        //   - 保留 bot 消息
        valid = valid.filter((msg, idx) => {
          if (idx < sinceIndex) return false;
          if (idx === sinceIndex) return true;
          // bot 消息保留
          if (msg.isBot) return true;
          // 用户回复保留，新问题排除
          if (msg.isReply) return true;
          return false;
        });
      }
    }

    // 取最后 limit 条
    return valid.slice(-limit);
  }

  /**
   * 清理过期消息
   */
  private cleanup(): void {
    const now = Date.now();
    let cleanedChats = 0;

    for (const [chatId, messages] of this.store.entries()) {
      const before = messages.length;
      const filtered = messages.filter(msg => now - msg.timestamp.getTime() < this.expiryMs);

      if (filtered.length === 0) {
        this.store.delete(chatId);
        cleanedChats++;
      } else if (filtered.length < before) {
        this.store.set(chatId, filtered);
      }
    }

    if (cleanedChats > 0) {
      log("debug", "telegram.conversation_store.cleanup", {
        cleanedChats,
        remainingChats: this.store.size
      });
    }
  }

  /**
   * 销毁（停止定时器）
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.store.clear();
  }
}
