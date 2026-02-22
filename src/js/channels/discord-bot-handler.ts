/**
 * Discord Bot 消息处理器
 *
 * 无状态、观察者模式的多Bot协作处理器
 * 每个Bot独立决策，不相互通信
 */

import crypto from "node:crypto";
import fs from "node:fs";
import type { Client, Message, TextChannel } from "discord.js";
import type { ChatEngine } from "../core/engine.js";
import { wrapChatEngine } from "../core/engine.js";
import type { DiscordBotConfig } from "../shared/config.js";
import { log } from "../shared/logger.js";
import { splitTextIntoChunks } from "../shared/text-chunk.js";
import {
  getRoleConfig,
  isNewUserQuestion,
  getRecentChannelHistory,
  formatConversationHistory,
  aiDecideParticipation,
  type BotRoleConfig
} from "./bot-roles.js";
import { DiscordAttachmentProcessor } from "./discord-attachment-processor.js";

/** Discord 单条消息长度限制 */
const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * 观察任务上下文
 */
interface ObservationTask {
  timer: NodeJS.Timeout;
  triggerMessageId: string;
  channelId: string;
  startTime: number;
}

/**
 * 参与记录（用于AI话题去重）
 */
interface ParticipationRecord {
  /** 上次参与时的话题摘要 */
  topicSummary: string;
  /** 参与时间戳 */
  timestamp: number;
}

/**
 * 话题缓存记录（阶段1.5：减少AI调用成本）
 */
interface TopicCacheRecord {
  /** 话题内容的MD5哈希 */
  hash: string;
  /** 缓存时间戳 */
  timestamp: number;
}

/**
 * Bot消息处理器
 */
export class DiscordBotHandler {
  // 优化：预编译正则表达式（避免重复编译）
  private static readonly XML_TAG_PAIR_REGEX = /<[a-zA-Z_][a-zA-Z0-9_-]*(\s+[^>]*)?>[\s\S]*?<\/[a-zA-Z_][a-zA-Z0-9_-]*>/g;
  private static readonly XML_TAG_SINGLE_REGEX = /<\/?[a-zA-Z_][a-zA-Z0-9_-]*(\s+[^>]*)?>/g;

  private roleConfig: BotRoleConfig;
  private allowedChannelIds: Set<string>;

  // 【附件处理器】统一处理语音、文档、图片附件
  private attachmentProcessor: DiscordAttachmentProcessor;

  // 【修复问题1】per-channel的观察定时器
  private observationTasks = new Map<string, ObservationTask>();

  // 【去除硬编码】最近参与过的话题（AI判断去重）
  private recentParticipations = new Map<string, ParticipationRecord>();
  private readonly maxParticipationAge = 3600000; // 1小时后无论如何都允许再次参与

  // 【阶段1.5 优化】话题哈希缓存（避免重复调用AI判断）
  private topicCache = new Map<string, TopicCacheRecord>();
  private readonly topicCacheTTL = 3600000; // 1小时
  private readonly MAX_TOPIC_CACHE_SIZE = 10000; // 优化：防止内存无限增长

  // 【修复问题6】定期清理定时器
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly cleanupIntervalMs = 60000; // 每分钟清理一次

  // P1-11修复：消息队列背压控制
  private messageQueue: Array<{ message: Message; timestamp: number }> = [];
  private readonly MAX_QUEUE_SIZE = 100; // 最多100条待处理消息
  private processingCount = 0; // 当前正在处理的消息数
  private readonly MAX_CONCURRENT = 5; // 最多同时处理5条消息
  private droppedMessageCount = 0; // 因队列满而丢弃的消息数

  // 阶段2.4：包装 agent 为 V2 版本
  private agentV2;

  constructor(
    private config: DiscordBotConfig,
    private agent: ChatEngine,
    private client: Client,
    roleConfig?: BotRoleConfig  // 可选：外部传入（AI决定的配置）
  ) {
    const agentId = config.agentId || "unknown";

    // 优先使用外部传入的roleConfig（已由AI决定延迟），否则获取默认配置
    this.roleConfig = roleConfig || getRoleConfig(agentId);
    this.allowedChannelIds = config.channels ? new Set(config.channels) : new Set();

    // 阶段2.4：包装为 V2
    this.agentV2 = wrapChatEngine(agent);

    // 初始化附件处理器（使用与 Discord bot 相同的代理）
    const proxyUrl = process.env.DISCORD_PROXY_URL;
    this.attachmentProcessor = new DiscordAttachmentProcessor({ proxyUrl });

    log("info", "discord.bot_handler.initialized", {
      agentId,
      roleName: this.roleConfig.name,
      strategy: this.roleConfig.participationStrategy,
      observationDelay: this.roleConfig.observationDelay,
      delaySource: roleConfig ? "ai_decided" : "default"
    });

    // 【修复问题6】启动定期清理
    this.startPeriodicCleanup();
  }

  /**
   * 处理收到的消息（阶段1.2：防崩包装）
   * P1-11修复：添加队列背压控制
   */
  async handleMessage(message: Message): Promise<void> {
    try {
      // 1. 基础过滤：忽略所有bot消息（包括自己和其他bot）
      if (message.author.bot) {
        return;
      }

      // 2. 频道白名单检查
      if (this.allowedChannelIds.size > 0 && !this.allowedChannelIds.has(message.channelId)) {
        return;
      }

      // P1-11修复：检查队列是否已满
      if (this.messageQueue.length >= this.MAX_QUEUE_SIZE) {
        this.droppedMessageCount++;
        log("warn", "discord.bot_handler.queue_full", {
          role: this.roleConfig.name,
          queueSize: this.messageQueue.length,
          processingCount: this.processingCount,
          droppedTotal: this.droppedMessageCount,
          channelId: message.channelId,
          messageId: message.id
        });

        // 尝试通知用户（不阻塞，失败也不重试）
        message.reply("⚠️ 消息队列已满，请稍后再试。").catch(() => {});
        return;
      }

      // P1-11修复：将消息加入队列
      this.messageQueue.push({
        message,
        timestamp: Date.now()
      });

      // P1-11修复：尝试处理队列中的消息
      this.processQueue();
    } catch (error) {
      // 双重保险：即使子方法有错误处理，这里也捕获意外异常
      log("error", "discord.bot_handler.handle_message.critical_error", {
        role: this.roleConfig.name,
        channelId: message.channelId,
        userId: message.author.id,
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined
      });

      // 尝试通知用户（如果失败也不抛出）
      try {
        await message.reply("系统遇到意外错误，已记录日志。请稍后重试。");
      } catch (replyError) {
        log("error", "discord.bot_handler.reply_error_message_failed", {
          error: String(replyError)
        });
      }
    }
  }

  /**
   * P1-11修复：处理队列中的消息（控制并发数）
   */
  private async processQueue(): Promise<void> {
    // 如果已经达到最大并发数，或队列为空，则不处理
    if (this.processingCount >= this.MAX_CONCURRENT || this.messageQueue.length === 0) {
      return;
    }

    // 从队列头部取出一条消息
    const item = this.messageQueue.shift();
    if (!item) return;

    const { message, timestamp } = item;
    const queueWaitTime = Date.now() - timestamp;

    this.processingCount++;

    // P1-11修复：记录队列指标
    log("debug", "discord.bot_handler.queue_metrics", {
      role: this.roleConfig.name,
      queueSize: this.messageQueue.length,
      processingCount: this.processingCount,
      queueWaitTime,
      droppedTotal: this.droppedMessageCount
    });

    try {
      // 3. 根据策略决定如何处理
      if (this.roleConfig.participationStrategy === "always_user_question") {
        await this.handleAsExpert(message);
      } else if (this.roleConfig.participationStrategy === "ai_decide") {
        await this.handleWithObservation(message);
      }
    } catch (error) {
      // 双重保险：即使子方法有错误处理，这里也捕获意外异常
      log("error", "discord.bot_handler.process_queue.error", {
        role: this.roleConfig.name,
        channelId: message.channelId,
        userId: message.author.id,
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined
      });

      // 尝试通知用户（如果失败也不抛出）
      try {
        await message.reply("系统遇到意外错误，已记录日志。请稍后重试。");
      } catch (replyError) {
        log("error", "discord.bot_handler.reply_error_message_failed", {
          error: String(replyError)
        });
      }
    } finally {
      // P1-11修复：处理完成后减少计数器并尝试处理下一条消息
      this.processingCount--;

      // 递归处理队列中的下一条消息
      this.processQueue();
    }
  }

  /**
   * 作为Expert处理（总是回答用户问题）
   */
  private async handleAsExpert(message: Message): Promise<void> {
    // 只响应新的用户问题（不是回复）
    if (!isNewUserQuestion(message)) {
      log("debug", "discord.bot_handler.expert.not_new_question", {
        hasReference: !!message.reference,
        role: this.roleConfig.name
      });
      return;
    }

    log("info", "discord.bot_handler.expert.responding", {
      role: this.roleConfig.name,
      channelId: message.channelId,
      userId: message.author.id
    });

    try {
      // 【附件处理】处理语音、文档、图片附件
      const attachments = await this.attachmentProcessor.processAllAttachments(message);

      // 构建完整的消息文本
      let fullMessage = message.content;

      // 优先使用语音转录（如果有语音附件）
      if (attachments.voiceTranscript) {
        fullMessage = attachments.voiceTranscript;
        log("info", "discord.bot_handler.expert.voice_used", {
          role: this.roleConfig.name,
          transcriptLength: fullMessage.length
        });
      }

      // 附加文档内容（如果有文档附件）
      if (attachments.documents?.length) {
        for (const doc of attachments.documents) {
          // 限制每个文档最多 20000 字符，避免超过 LLM 上下文限制
          const truncatedText = doc.text.slice(0, 20000);
          fullMessage += `\n\n【附件文档：${doc.filename}】\n${truncatedText}`;

          if (doc.text.length > 20000) {
            fullMessage += `\n\n（文档过长，已截取前 20000 字符）`;
          }
        }

        log("info", "discord.bot_handler.expert.documents_attached", {
          role: this.roleConfig.name,
          count: attachments.documents.length,
          files: attachments.documents.map(d => d.filename)
        });
      }

      // 附加图片理解结果（如果有图片附件）
      if (attachments.imageDescriptions?.length) {
        for (const img of attachments.imageDescriptions) {
          fullMessage += `\n\n【图片内容：${img.filename}】\n${img.description}`;
        }

        log("info", "discord.bot_handler.expert.images_understood", {
          role: this.roleConfig.name,
          count: attachments.imageDescriptions.length,
          files: attachments.imageDescriptions.map(i => i.filename)
        });
      } else if (attachments.images?.length) {
        // 记录图片附件但未成功理解
        log("warn", "discord.bot_handler.expert.images_not_understood", {
          role: this.roleConfig.name,
          count: attachments.images.length,
          files: attachments.images.map(i => i.filename)
        });
      }

      // 阶段2.4：使用 V2 API
      const result = await this.agentV2.replyV2(fullMessage, {
        userId: message.author.id,
        userName: message.author.username,
        channelId: message.channelId,
        agentId: this.config.agentId
      });

      // 处理失败结果
      if (!result.ok) {
        const userMessage = result.error.userMessage;
        await message.reply(userMessage);
        log("warn", "discord.bot_handler.expert.reply_failed", {
          role: this.roleConfig.name,
          code: result.error.code,
          retryable: result.retryable
        });
        return;
      }

      // robot-dog skill：检测 GIF 标记，拦截发送动画
      const gifResult = tryParseRobotGif(result.data);
      if (gifResult) {
        await message.reply({
          content: gifResult.command,
          files: [{ attachment: gifResult.filePath }]
        });
        fs.unlink(gifResult.filePath, () => {});
        return;
      }

      // 🔧 简单的 XML 标签过滤（安全网）
      let cleanedResponse = result.data;
      const originalLength = cleanedResponse.length;

      cleanedResponse = cleanedResponse
        .replace(DiscordBotHandler.XML_TAG_PAIR_REGEX, '')
        .replace(DiscordBotHandler.XML_TAG_SINGLE_REGEX, '')
        .trim();

      if (cleanedResponse.length !== originalLength) {
        log("warn", "discord.bot_handler.xml_tags_filtered", {
          role: this.roleConfig.name,
          originalLength,
          cleanedLength: cleanedResponse.length,
          removedBytes: originalLength - cleanedResponse.length
        });
      }

      // 如果过滤后为空，提供友好提示
      if (!cleanedResponse) {
        cleanedResponse = "抱歉，我的回复包含了一些技术细节，已被过滤。请重新提问，我会给您一个更清晰的答复。";
        log("error", "discord.bot_handler.response_empty_after_filter", {
          role: this.roleConfig.name,
          originalLength
        });
      }

      // 分段发送（Discord 限制 2000 字符）
      const chunks = splitTextIntoChunks(cleanedResponse, { maxLength: DISCORD_MESSAGE_LIMIT });

      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          await message.reply(chunks[i]);
        } else {
          // 类型断言：确保 channel 是 TextChannel
          if ('send' in message.channel) {
            await message.channel.send(chunks[i]);
          }
        }
      }

      log("info", "discord.bot_handler.expert.replied", {
        role: this.roleConfig.name,
        responseLength: cleanedResponse.length,
        chunks: chunks.length
      });
    } catch (error) {
      log("error", "discord.bot_handler.expert.failed", {
        role: this.roleConfig.name,
        error: String(error)
      });

      await message.reply("抱歉，我现在无法回答这个问题，请稍后再试。");
    }
  }

  /**
   * AI判断话题是否改变（阶段1.5：增加哈希缓存，减少AI调用）
   */
  private async isTopicChanged(
    channelId: string,
    currentTopicSummary: string
  ): Promise<boolean> {
    const lastParticipation = this.recentParticipations.get(channelId);

    // 第一次参与，允许
    if (!lastParticipation) {
      return true;
    }

    // 超过1小时，无论如何都允许再次参与
    if (Date.now() - lastParticipation.timestamp > this.maxParticipationAge) {
      log("debug", "discord.bot_handler.topic_check.expired", {
        role: this.roleConfig.name,
        channelId,
        age: Date.now() - lastParticipation.timestamp
      });
      return true;
    }

    // 【阶段1.5】计算话题哈希，检查缓存
    const currentHash = crypto.createHash("md5").update(currentTopicSummary).digest("hex");
    const cached = this.topicCache.get(channelId);

    if (cached && Date.now() - cached.timestamp < this.topicCacheTTL) {
      const isSame = cached.hash === currentHash;
      if (isSame) {
        log("debug", "discord.bot_handler.topic_cache.hit", {
          role: this.roleConfig.name,
          channelId
        });
        return false; // 话题未改变，缓存命中，无需调用AI
      } else {
        log("debug", "discord.bot_handler.topic_cache.hash_changed", {
          role: this.roleConfig.name,
          channelId
        });
      }
    }

    // 缓存未命中或已过期，调用AI判断
    try {
      const prompt = `对比以下两个话题，判断是否是不同的话题：

话题A（上次参与）：${lastParticipation.topicSummary}

话题B（当前）：${currentTopicSummary}

判断标准：
- 如果讨论的是不同的问题、不同的主题，回答 YES
- 如果还在讨论同一个问题、同一个主题（即使角度不同），回答 NO

只回答 YES 或 NO，不要解释。`;

      const response = await this.agent.reply(prompt, {
        userId: "system",
        userName: "TopicChangeDetection",
        channelId: "internal"
      });

      const decision = response.trim().toUpperCase();
      const isYes = decision === "YES" || decision.startsWith("YES");
      const isNo = decision === "NO" || decision.startsWith("NO");

      // 如果AI回答不清晰，保守策略：认为话题未改变（不参与）
      if (!isYes && !isNo) {
        log("warn", "discord.bot_handler.topic_check.unclear", {
          role: this.roleConfig.name,
          decision
        });
        return false;
      }

      const topicChanged = isYes;

      // 【阶段1.5】更新话题缓存
      this.topicCache.set(channelId, {
        hash: currentHash,
        timestamp: Date.now()
      });

      log("info", "discord.bot_handler.topic_check.result", {
        role: this.roleConfig.name,
        channelId,
        topicChanged,
        lastTopic: lastParticipation.topicSummary.substring(0, 50),
        currentTopic: currentTopicSummary.substring(0, 50),
        cacheUpdated: true
      });

      return topicChanged;
    } catch (error) {
      log("error", "discord.bot_handler.topic_check.failed", {
        role: this.roleConfig.name,
        error: String(error)
      });
      // 出错时保守策略：不参与
      return false;
    }
  }

  /**
   * 通过观察决定是否参与
   */
  private async handleWithObservation(message: Message): Promise<void> {
    // 只观察频道中的对话消息
    if (!message.channel.isTextBased()) {
      return;
    }

    // 【修复问题3】观察新问题和用户回复
    const isRelevantMessage = isNewUserQuestion(message) ||
                              (message.reference && !message.author.bot);

    if (!isRelevantMessage) {
      log("debug", "discord.bot_handler.observation.not_relevant", {
        role: this.roleConfig.name,
        hasReference: !!message.reference
      });
      return;
    }

    const channelId = message.channelId;

    // 【AI驱动去重】话题判断移到observeAndDecide中，在获取历史后进行
    // 这里只检查是否已有观察任务

    // 【修复问题1】检查该频道是否已有观察任务
    if (this.observationTasks.has(channelId)) {
      log("debug", "discord.bot_handler.observation.already_scheduled", {
        role: this.roleConfig.name,
        channelId
      });
      return;
    }

    // 设置观察延迟
    const delay = this.roleConfig.observationDelay;

    log("debug", "discord.bot_handler.observation.scheduled", {
      role: this.roleConfig.name,
      delay,
      channelId,
      triggerMessageId: message.id
    });

    const timer = setTimeout(async () => {
      try {
        await this.observeAndDecide(message);
      } catch (error) {
        log("error", "discord.bot_handler.observation.failed", {
          role: this.roleConfig.name,
          error: String(error)
        });
      } finally {
        this.observationTasks.delete(channelId);
      }
    }, delay);

    // 【修复问题1】记录per-channel的观察任务
    this.observationTasks.set(channelId, {
      timer,
      triggerMessageId: message.id,
      channelId,
      startTime: Date.now()
    });
  }

  /**
   * 观察对话并决定是否参与
   */
  private async observeAndDecide(triggerMessage: Message): Promise<void> {
    const channel = triggerMessage.channel;

    if (!channel.isTextBased()) {
      return;
    }

    log("info", "discord.bot_handler.observation.start", {
      role: this.roleConfig.name,
      channelId: channel.id
    });

    // 【修复问题8+问题9】获取对话历史，处理消息可能已删除的情况
    let history: Array<{ author: string; content: string; isBot: boolean; timestamp: Date }>;
    try {
      // 【修复问题9】获取从触发消息开始的历史（包括触发消息和bot回复）
      // 同时排除观察期间用户发的新问题，避免话题混乱
      history = await getRecentChannelHistory(
        channel as TextChannel,
        this.roleConfig.maxObservationMessages || 10,
        triggerMessage.id // 从这条消息开始（包含），排除后续新问题
      );
    } catch (error) {
      log("warn", "discord.bot_handler.observation.history_fetch_failed", {
        role: this.roleConfig.name,
        channelId: channel.id,
        error: String(error)
      });
      // 如果fetch失败（消息可能被删除），尝试不带sinceMessageId获取最新历史
      history = await getRecentChannelHistory(
        channel as TextChannel,
        this.roleConfig.maxObservationMessages || 10
      );
    }

    if (history.length === 0) {
      log("debug", "discord.bot_handler.observation.no_history", {
        role: this.roleConfig.name
      });
      return;
    }

    // 格式化对话历史
    const formattedHistory = formatConversationHistory(history);

    log("debug", "discord.bot_handler.observation.history", {
      role: this.roleConfig.name,
      messageCount: history.length,
      historyLength: formattedHistory.length
    });

    // 【AI驱动去重】提取话题摘要并判断是否需要参与
    // 用最新的用户消息作为话题摘要（简化处理）
    const latestUserMessage = history
      .slice()
      .reverse()
      .find(msg => !msg.isBot);

    // 提取话题摘要（如果没有用户消息，使用整个对话作为摘要）
    let currentTopicSummary = "";
    if (latestUserMessage) {
      currentTopicSummary = latestUserMessage.content.substring(0, 200); // 取前200字符作为摘要
    } else {
      // 边界情况：没有用户消息，用整个对话作为摘要
      currentTopicSummary = formattedHistory.substring(0, 200);
      log("warn", "discord.bot_handler.observation.no_user_message", {
        role: this.roleConfig.name,
        channelId: channel.id
      });
    }

    // 话题判断（只要有内容就判断）
    if (currentTopicSummary) {
      const topicChanged = await this.isTopicChanged(channel.id, currentTopicSummary);

      if (!topicChanged) {
        log("info", "discord.bot_handler.observation.topic_unchanged", {
          role: this.roleConfig.name,
          channelId: channel.id,
          reason: "same_topic"
        });
        return; // 话题未改变，不参与
      }

      log("info", "discord.bot_handler.observation.topic_changed", {
        role: this.roleConfig.name,
        channelId: channel.id
      });
    }

    // 【FIX】在AI参与判断之前，重新获取最新的历史
    // 原因：在话题判断期间（可能耗时2-5秒），Bot1可能已经回复了
    // 需要确保AI判断时能看到最新的对话（包括Bot1的回复）
    try {
      const latestHistory = await getRecentChannelHistory(
        channel as TextChannel,
        this.roleConfig.maxObservationMessages || 10,
        triggerMessage.id
      );

      if (latestHistory.length > 0) {
        history = latestHistory;
        log("debug", "discord.bot_handler.observation.history_refreshed", {
          role: this.roleConfig.name,
          messageCount: history.length
        });
      }
    } catch (error) {
      // 重新获取失败不影响流程，继续使用原有历史
      log("warn", "discord.bot_handler.observation.refresh_failed", {
        role: this.roleConfig.name,
        error: String(error)
      });
    }

    // 使用最新的历史进行格式化
    const latestFormattedHistory = formatConversationHistory(history);

    // AI决策是否参与（使用最新的历史）
    const decision = await aiDecideParticipation(
      this.agent,
      this.roleConfig,
      latestFormattedHistory
    );

    if (!decision.shouldParticipate) {
      log("info", "discord.bot_handler.observation.declined", {
        role: this.roleConfig.name,
        reason: decision.reason
      });
      return;
    }

    log("info", "discord.bot_handler.observation.participating", {
      role: this.roleConfig.name,
      channelId: channel.id
    });

    // 【方案C延伸】如果角色需要最完整的上下文（如总结型角色），发言前再次刷新历史
    // 确保看到在AI判断期间产生的新消息（如用户追问、其他bot的补充等）
    if (this.roleConfig.refreshBeforeReply) {
      try {
        const finalHistory = await getRecentChannelHistory(
          channel as TextChannel,
          this.roleConfig.maxObservationMessages || 10,
          triggerMessage.id
        );

        if (finalHistory.length > 0) {
          history = finalHistory;
          log("debug", "discord.bot_handler.observation.final_refresh", {
            role: this.roleConfig.name,
            messageCount: finalHistory.length,
            reason: "comprehensive_summary"
          });
        }
      } catch (error) {
        // 刷新失败不影响流程，继续使用之前的历史
        log("warn", "discord.bot_handler.observation.final_refresh_failed", {
          role: this.roleConfig.name,
          error: String(error)
        });
      }
    }

    // 使用最新的历史构造提示（可能经过了两次刷新）
    const finalFormattedHistory = formatConversationHistory(history);
    const fullPrompt = `${finalFormattedHistory}\n\n---\n\n你是【${this.roleConfig.name}】，${this.roleConfig.description}。请从你的角色出发，对上述对话进行回应。`;

    try {
      const response = await this.agent.reply(fullPrompt, {
        userId: "system",
        userName: this.roleConfig.name,
        channelId: channel.id,
        agentId: this.config.agentId
      });

      // 🔧 简单的 XML 标签过滤（安全网，正常情况下不应该触发）
      let cleanedResponse = response;
      const originalLength = cleanedResponse.length;

      // 移除任何可能的 XML 标签（成对的和单独的）
      cleanedResponse = cleanedResponse
        .replace(DiscordBotHandler.XML_TAG_PAIR_REGEX, '') // 成对标签
        .replace(DiscordBotHandler.XML_TAG_SINGLE_REGEX, '') // 单独的开始/结束标签
        .trim();

      if (cleanedResponse.length !== originalLength) {
        log("warn", "discord.bot_handler.xml_tags_filtered", {
          role: this.roleConfig.name,
          originalLength,
          cleanedLength: cleanedResponse.length,
          removedBytes: originalLength - cleanedResponse.length
        });
      }

      // 如果过滤后为空，提供友好提示
      if (!cleanedResponse) {
        cleanedResponse = "抱歉，我的回复包含了一些技术细节，已被过滤。请重新提问，我会给您一个更清晰的答复。";
        log("error", "discord.bot_handler.response_empty_after_filter", {
          role: this.roleConfig.name,
          originalLength
        });
      }

      // 分段发送（Discord 限制 2000 字符）
      const chunks = splitTextIntoChunks(cleanedResponse, { maxLength: DISCORD_MESSAGE_LIMIT });

      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          // 第一条消息带角色前缀
          await (channel as TextChannel).send(
            `**${this.roleConfig.name}的观点：**\n\n${chunks[i]}`
          );
        } else {
          // 后续消息直接发送（继续内容）
          await (channel as TextChannel).send(chunks[i]);
        }
      }

      // 【AI驱动去重】记录话题摘要和参与时间
      // 无论摘要是否为空，都记录参与（避免重复判断为"第一次"）
      this.recentParticipations.set(channel.id, {
        topicSummary: currentTopicSummary || "unknown",  // 如果为空，记录"unknown"
        timestamp: Date.now()
      });

      log("info", "discord.bot_handler.observation.participated", {
        role: this.roleConfig.name,
        responseLength: response.length,
        chunks: chunks.length,
        topicSummary: currentTopicSummary.substring(0, 50) || "unknown"
      });
    } catch (error) {
      log("error", "discord.bot_handler.observation.reply_failed", {
        role: this.roleConfig.name,
        error: String(error)
      });
    }
  }

  /**
   * 启动定期清理
   */
  private startPeriodicCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.performCleanup();
    }, this.cleanupIntervalMs);

    // 优化：允许进程优雅退出，即使定时器还在运行
    this.cleanupInterval.unref();
  }

  /**
   * 执行清理操作
   */
  private performCleanup(): void {
    const now = Date.now();

    // 清理附件临时文件（超过1小时的）
    this.attachmentProcessor.cleanupOldTempFiles();

    // 清理过期的参与记录（超过1小时）
    let cleanedParticipations = 0;
    let cleanedMessages = 0; // P1-11修复：消息队列清理计数
    for (const [channelId, record] of this.recentParticipations.entries()) {
      if (now - record.timestamp > this.maxParticipationAge) {
        this.recentParticipations.delete(channelId);
        cleanedParticipations++;
      }
    }

    // 【阶段1.5 优化】清理过期的话题缓存（超过1小时）
    let cleanedTopicCache = 0;
    for (const [channelId, record] of this.topicCache.entries()) {
      if (now - record.timestamp > this.topicCacheTTL) {
        this.topicCache.delete(channelId);
        cleanedTopicCache++;
      }
    }

    // 优化：如果缓存仍然超过最大限制，删除最旧的项
    if (this.topicCache.size > this.MAX_TOPIC_CACHE_SIZE) {
      const entries = Array.from(this.topicCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);

      const toDelete = entries.slice(0, this.topicCache.size - this.MAX_TOPIC_CACHE_SIZE);
      toDelete.forEach(([key]) => this.topicCache.delete(key));

      cleanedTopicCache += toDelete.length;

      log("warn", "discord.bot_handler.cache.size_limit", {
        role: this.roleConfig.name,
        maxSize: this.MAX_TOPIC_CACHE_SIZE,
        deleted: toDelete.length,
        remaining: this.topicCache.size
      });
    }

    // P1-11修复：清理过期的消息队列（超过5分钟未处理的消息）
    const MESSAGE_MAX_AGE = 5 * 60 * 1000; // 5分钟
    const originalQueueSize = this.messageQueue.length;

    this.messageQueue = this.messageQueue.filter(item => {
      const age = now - item.timestamp;
      if (age > MESSAGE_MAX_AGE) {
        cleanedMessages++;
        return false;
      }
      return true;
    });

    if (cleanedMessages > 0) {
      log("warn", "discord.bot_handler.queue_cleanup", {
        role: this.roleConfig.name,
        cleanedMessages,
        originalQueueSize,
        currentQueueSize: this.messageQueue.length,
        processingCount: this.processingCount
      });
    }

    // 清理超时的观察任务（超过观察延迟+1分钟的）
    let cleanedTasks = 0;
    for (const [channelId, task] of this.observationTasks.entries()) {
      const maxAge = this.roleConfig.observationDelay + 60000; // 观察延迟+1分钟
      if (now - task.startTime > maxAge) {
        clearTimeout(task.timer);
        this.observationTasks.delete(channelId);
        cleanedTasks++;
        log("warn", "discord.bot_handler.task.timeout", {
          role: this.roleConfig.name,
          channelId,
          age: now - task.startTime
        });
      }
    }

    if (cleanedParticipations > 0 || cleanedTopicCache > 0 || cleanedTasks > 0 || cleanedMessages > 0) {
      log("debug", "discord.bot_handler.cleanup", {
        role: this.roleConfig.name,
        cleanedParticipations,
        cleanedTopicCache,
        cleanedTasks,
        cleanedMessages,
        remainingParticipations: this.recentParticipations.size,
        remainingTopicCache: this.topicCache.size,
        remainingTasks: this.observationTasks.size,
        currentQueueSize: this.messageQueue.length,
        processingCount: this.processingCount,
        droppedTotal: this.droppedMessageCount
      });
    }
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    // 停止定期清理
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // 清理所有观察定时器
    for (const task of this.observationTasks.values()) {
      clearTimeout(task.timer);
    }
    this.observationTasks.clear();

    // 清理所有参与记录
    this.recentParticipations.clear();

    log("info", "discord.bot_handler.cleanup.complete", {
      role: this.roleConfig.name
    });
  }
}

/**
 * 检测 robot-dog skill 返回的 GIF 标记。
 * skill 返回格式：[skill:robot-dog]\n{"type":"robot_gif","filePath":"...","command":"..."}
 */
function tryParseRobotGif(text: string): { filePath: string; command: string } | null {
  const idx = text.indexOf('{"type":"robot_gif"');
  if (idx === -1) return null;
  try {
    const parsed = JSON.parse(text.slice(idx));
    if (parsed.type === "robot_gif" && typeof parsed.filePath === "string") {
      return { filePath: parsed.filePath, command: String(parsed.command || "") };
    }
  } catch {}
  return null;
}
