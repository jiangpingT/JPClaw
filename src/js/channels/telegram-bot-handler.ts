/**
 * Telegram Bot 消息处理器
 *
 * 镜像 DiscordBotHandler 的无状态、观察者模式多 Bot 协作处理器。
 * 每个 Bot 独立决策，不相互通信。
 * 使用共享 ConversationStore 替代 Discord 的 getRecentChannelHistory。
 */

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type TelegramBot from "node-telegram-bot-api";
import type { ChatEngine } from "../core/engine.js";
import { wrapChatEngine } from "../core/engine.js";
import { getDefaultGatewayClient } from "../llm/gateway-client.js";
import { MediaProcessor } from "../media/processor.js";
import type { TelegramBotConfig } from "../shared/config.js";
import { log } from "../shared/logger.js";
import { splitTextIntoChunks, resolveMessageChunkLimit } from "../shared/text-chunk.js";
import {
  getRoleConfig,
  formatConversationHistory,
  aiDecideParticipation,
  type BotRoleConfig
} from "./bot-roles.js";
import { extractText } from "./document-text-extractor.js";
import type { ConversationStore } from "./telegram-conversation-store.js";

/** Telegram 单条消息上限 4096 字符，留余量用 4000 */
const TELEGRAM_MESSAGE_LIMIT = resolveMessageChunkLimit("telegram", 4000);

/** 音视频多模态处理使用的模型（需要原生支持音频/视频输入） */
const MULTIMODAL_MODEL = process.env.MULTIMODAL_MODEL || "gemini-2.5-pro";

/** 发送超时 */
const SEND_TIMEOUT_MS = Number(process.env.TELEGRAM_SEND_TIMEOUT_MS || "30000");

/**
 * 观察任务上下文
 */
interface ObservationTask {
  timer: NodeJS.Timeout;
  triggerMessageId: number;
  chatId: string;
  startTime: number;
}

/**
 * 参与记录（用于 AI 话题去重）
 */
interface ParticipationRecord {
  topicSummary: string;
  timestamp: number;
}

/**
 * 话题缓存记录（减少 AI 调用成本）
 */
interface TopicCacheRecord {
  hash: string;
  timestamp: number;
}

/**
 * Telegram Bot 消息处理器
 */
export class TelegramBotHandler {
  // 预编译正则表达式（过滤 XML 标签）
  private static readonly XML_TAG_PAIR_REGEX = /<[a-zA-Z_][a-zA-Z0-9_-]*(\s+[^>]*)?>[\s\S]*?<\/[a-zA-Z_][a-zA-Z0-9_-]*>/g;
  private static readonly XML_TAG_SINGLE_REGEX = /<\/?[a-zA-Z_][a-zA-Z0-9_-]*(\s+[^>]*)?>/g;

  private roleConfig: BotRoleConfig;

  // per-chat 的观察定时器
  private observationTasks = new Map<string, ObservationTask>();

  // AI 话题去重
  private recentParticipations = new Map<string, ParticipationRecord>();
  private readonly maxParticipationAge = 3600000; // 1 小时

  // 话题哈希缓存
  private topicCache = new Map<string, TopicCacheRecord>();
  private readonly topicCacheTTL = 3600000;
  private readonly MAX_TOPIC_CACHE_SIZE = 10000;

  // 定期清理
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly cleanupIntervalMs = 60000;

  // 消息队列背压控制
  private messageQueue: Array<{ msg: TelegramBot.Message; timestamp: number }> = [];
  private readonly MAX_QUEUE_SIZE = 100;
  private processingCount = 0;
  private readonly MAX_CONCURRENT = 5;
  private droppedMessageCount = 0;

  // 附件临时目录
  private readonly tempDir: string;

  // V2 引擎
  private agentV2;

  constructor(
    private config: TelegramBotConfig,
    private agent: ChatEngine,
    private bot: TelegramBot,
    private conversationStore: ConversationStore,
    roleConfig?: BotRoleConfig
  ) {
    const agentId = config.agentId || "unknown";

    this.roleConfig = roleConfig || getRoleConfig(agentId);
    this.agentV2 = wrapChatEngine(agent);
    this.tempDir = path.resolve(process.cwd(), "tmp", "telegram-attachments");
    fs.mkdirSync(this.tempDir, { recursive: true });

    log("info", "telegram.bot_handler.initialized", {
      agentId,
      roleName: this.roleConfig.name,
      strategy: this.roleConfig.participationStrategy,
      observationDelay: this.roleConfig.observationDelay,
      delaySource: roleConfig ? "ai_decided" : "default"
    });

    this.startPeriodicCleanup();
  }

  /**
   * 处理收到的消息（入口，含背压控制）
   */
  async handleMessage(msg: TelegramBot.Message): Promise<void> {
    try {
      // 过滤 bot 消息
      if (msg.from?.is_bot) return;

      // 提取文本（语音/文件消息可能没有文本，也放行）
      const text = (msg.text || msg.caption || "").trim();
      const hasAttachment = !!(msg.voice || msg.audio || msg.document || msg.photo?.length || msg.video || msg.video_note);
      if (!text && !hasAttachment) return;

      // 背压：队列满时丢弃
      if (this.messageQueue.length >= this.MAX_QUEUE_SIZE) {
        this.droppedMessageCount++;
        log("warn", "telegram.bot_handler.queue_full", {
          role: this.roleConfig.name,
          queueSize: this.messageQueue.length,
          processingCount: this.processingCount,
          droppedTotal: this.droppedMessageCount,
          chatId: msg.chat.id
        });
        return;
      }

      this.messageQueue.push({ msg, timestamp: Date.now() });
      this.processQueue();
    } catch (error) {
      log("error", "telegram.bot_handler.handle_message.critical_error", {
        role: this.roleConfig.name,
        chatId: msg.chat.id,
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  }

  /**
   * 处理队列中的消息（控制并发数）
   */
  private async processQueue(): Promise<void> {
    if (this.processingCount >= this.MAX_CONCURRENT || this.messageQueue.length === 0) return;

    const item = this.messageQueue.shift();
    if (!item) return;

    const { msg, timestamp } = item;
    const queueWaitTime = Date.now() - timestamp;
    this.processingCount++;

    log("debug", "telegram.bot_handler.queue_metrics", {
      role: this.roleConfig.name,
      queueSize: this.messageQueue.length,
      processingCount: this.processingCount,
      queueWaitTime,
      droppedTotal: this.droppedMessageCount
    });

    try {
      if (this.roleConfig.participationStrategy === "always_user_question") {
        await this.handleAsExpert(msg);
      } else if (this.roleConfig.participationStrategy === "ai_decide") {
        await this.handleWithObservation(msg);
      }
    } catch (error) {
      log("error", "telegram.bot_handler.process_queue.error", {
        role: this.roleConfig.name,
        chatId: msg.chat.id,
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    } finally {
      this.processingCount--;
      this.processQueue();
    }
  }

  /**
   * 作为 Expert 处理（总是回答用户问题）
   */
  private async handleAsExpert(msg: TelegramBot.Message): Promise<void> {
    // Expert 只响应非回复消息（新问题）
    if (msg.reply_to_message) {
      log("debug", "telegram.bot_handler.expert.not_new_question", {
        role: this.roleConfig.name,
        hasReply: true
      });
      return;
    }

    let text = (msg.text || msg.caption || "").trim();
    const chatId = msg.chat.id;
    const userId = msg.from?.id || 0;
    const userName =
      msg.from?.username ||
      [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") ||
      "unknown";

    log("info", "telegram.bot_handler.expert.responding", {
      role: this.roleConfig.name,
      chatId,
      userId
    });

    // 附件处理：语音/视频优先替换文本，文档追加到文本
    const voiceTranscript = await this.processVoice(msg);
    if (voiceTranscript) {
      text = voiceTranscript;
      log("info", "telegram.bot_handler.expert.voice_used", {
        role: this.roleConfig.name,
        transcriptLength: text.length
      });
    }

    else {
      const videoContent = await this.processVideo(msg);
      if (videoContent) {
        const videoSection = `\n\n【视频内容】\n${videoContent}`;
        text = text ? text + videoSection : videoSection.trim();
        log("info", "telegram.bot_handler.expert.video_used", {
          role: this.roleConfig.name,
          contentLength: videoContent.length
        });
      }
    }

    const docResult = await this.processDocument(msg);
    if (docResult) {
      const docSection = `\n\n【附件文档：${docResult.filename}】\n${docResult.text}`;
      text = text ? text + docSection : docSection.trim();
      log("info", "telegram.bot_handler.expert.document_appended", {
        role: this.roleConfig.name,
        filename: docResult.filename,
        textLength: docResult.text.length
      });
    }

    const photoDescription = await this.processPhoto(msg);
    if (photoDescription) {
      const photoSection = `\n\n【图片内容】\n${photoDescription}`;
      text = text ? text + photoSection : photoSection.trim();
      log("info", "telegram.bot_handler.expert.photo_understood", {
        role: this.roleConfig.name,
        descriptionLength: photoDescription.length
      });
    }

    // 处理后仍无内容，跳过
    if (!text) return;

    // 记录用户消息到 conversationStore（新问题，isReply=false）
    this.conversationStore.recordMessage(chatId, userName, text, false, msg.message_id, false);

    try {
      // 发送 typing 状态
      this.bot.sendChatAction(chatId, "typing").catch(() => {});

      // 调用 AI
      const result = await this.agentV2.replyV2(text, {
        userId: String(userId),
        userName,
        channelId: `telegram:${chatId}`,
        agentId: this.config.agentId
      });

      if (!result.ok) {
        await this.sendReply(chatId, result.error.userMessage, msg.message_id);
        log("warn", "telegram.bot_handler.expert.reply_failed", {
          role: this.roleConfig.name,
          code: result.error.code,
          retryable: result.retryable
        });
        return;
      }

      // XML 标签过滤
      let cleanedResponse = this.filterXmlTags(result.data);

      if (!cleanedResponse) {
        cleanedResponse = "抱歉，我的回复包含了一些技术细节，已被过滤。请重新提问，我会给您一个更清晰的答复。";
      }

      // 记录 bot 回复到 conversationStore
      this.conversationStore.recordMessage(chatId, this.roleConfig.name, cleanedResponse, true);

      // 分段发送
      await this.sendReply(chatId, cleanedResponse, msg.message_id);

      log("info", "telegram.bot_handler.expert.replied", {
        role: this.roleConfig.name,
        responseLength: cleanedResponse.length
      });
    } catch (error) {
      log("error", "telegram.bot_handler.expert.failed", {
        role: this.roleConfig.name,
        error: String(error)
      });
      await this.sendReply(chatId, "抱歉，我现在无法回答这个问题，请稍后再试。", msg.message_id);
    }
  }

  /**
   * 通过观察决定是否参与
   */
  private async handleWithObservation(msg: TelegramBot.Message): Promise<void> {
    let text = (msg.text || msg.caption || "").trim();
    const chatId = msg.chat.id;
    const chatKey = String(chatId);

    // 观察新问题和用户回复
    const isUserReply = !!msg.reply_to_message && !msg.from?.is_bot;
    const isNewQuestion = !msg.reply_to_message && !msg.from?.is_bot;

    if (!isNewQuestion && !isUserReply) {
      return;
    }

    // 为附件消息生成描述性文本（用于记录到 store）
    if (!text) {
      if (msg.voice || msg.audio) {
        text = "[语音消息]";
      } else if (msg.video || msg.video_note) {
        text = "[视频消息]";
      } else if (msg.document) {
        text = `[文件: ${msg.document.file_name || "unknown"}]`;
      } else if (msg.photo?.length) {
        text = "[图片]";
      }
    }

    if (!text) return;

    // 记录用户消息到 conversationStore（区分新问题和回复）
    const userName =
      msg.from?.username ||
      [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") ||
      "unknown";
    this.conversationStore.recordMessage(chatId, userName, text, false, msg.message_id, isUserReply);

    // 检查该 chat 是否已有观察任务
    if (this.observationTasks.has(chatKey)) {
      log("debug", "telegram.bot_handler.observation.already_scheduled", {
        role: this.roleConfig.name,
        chatId: chatKey
      });
      return;
    }

    const delay = this.roleConfig.observationDelay;

    log("debug", "telegram.bot_handler.observation.scheduled", {
      role: this.roleConfig.name,
      delay,
      chatId: chatKey,
      triggerMessageId: msg.message_id
    });

    const timer = setTimeout(async () => {
      try {
        await this.observeAndDecide(msg);
      } catch (error) {
        log("error", "telegram.bot_handler.observation.failed", {
          role: this.roleConfig.name,
          error: String(error)
        });
      } finally {
        this.observationTasks.delete(chatKey);
      }
    }, delay);

    this.observationTasks.set(chatKey, {
      timer,
      triggerMessageId: msg.message_id,
      chatId: chatKey,
      startTime: Date.now()
    });
  }

  /**
   * 处理语音消息：下载 → 直接传给多模态模型原生理解
   */
  private async processVoice(msg: TelegramBot.Message): Promise<string | null> {
    const voiceOrAudio = msg.voice || msg.audio;
    if (!voiceOrAudio) return null;

    let localPath: string | null = null;
    let mp3Path: string | null = null;
    try {
      localPath = await this.bot.downloadFile(voiceOrAudio.file_id, this.tempDir);
      const originalMime = voiceOrAudio.mime_type || "audio/ogg";

      log("info", "telegram.bot_handler.voice.downloaded", {
        role: this.roleConfig.name,
        fileSize: voiceOrAudio.file_size,
        mimeType: originalMime
      });

      // Gemini 不支持 OGG/Opus（Telegram 语音格式），转成 MP3 后再送入
      mp3Path = localPath.replace(/\.[^.]+$/, "") + "_converted.mp3";
      execFileSync("ffmpeg", ["-y", "-i", localPath, "-ar", "16000", "-ac", "1", "-b:a", "64k", mp3Path], {
        stdio: "ignore"
      });
      log("info", "telegram.bot_handler.voice.converted", {
        role: this.roleConfig.name,
        from: path.extname(localPath),
        to: ".mp3"
      });

      // 用 Whisper STT 接口转录（网关 OpenAI 兼容，音频专用模型）
      const sttBaseUrl = process.env.MININGLAMP_GATEWAY_BASE_URL || "https://llm-guard.mininglamp.com";
      const sttApiKey = process.env.MININGLAMP_GATEWAY_API_KEY || process.env.LLM_GATEWAY_API_KEY || "";
      const sttModel = process.env.MININGLAMP_GATEWAY_STT_MODEL || "whisper-1";

      const formData = new FormData();
      formData.append("file", new Blob([fs.readFileSync(mp3Path)], { type: "audio/mpeg" }), "voice.mp3");
      formData.append("model", sttModel);
      formData.append("language", "zh");

      const sttResponse = await fetch(`${sttBaseUrl}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sttApiKey}` },
        body: formData
      });

      if (!sttResponse.ok) {
        log("warn", "telegram.bot_handler.voice.stt_failed", {
          role: this.roleConfig.name,
          status: sttResponse.status
        });
        return null;
      }

      const sttData = await sttResponse.json() as { text?: string };
      const result = sttData.text?.trim() || null;

      if (result) {
        log("info", "telegram.bot_handler.voice.understood", {
          role: this.roleConfig.name,
          resultLength: result.length,
          resultPreview: result.substring(0, 100)
        });
      } else {
        log("warn", "telegram.bot_handler.voice.understanding_failed", {
          role: this.roleConfig.name
        });
      }

      return result;
    } catch (error) {
      log("error", "telegram.bot_handler.voice.error", {
        role: this.roleConfig.name,
        error: String(error)
      });
      return null;
    } finally {
      if (localPath) { try { fs.unlinkSync(localPath); } catch {} }
      if (mp3Path) { try { fs.unlinkSync(mp3Path); } catch {} }
    }
  }

  /**
   * 处理视频消息：音轨 → Whisper STT，关键帧 → Vision API，结果合并
   */
  private async processVideo(msg: TelegramBot.Message): Promise<string | null> {
    const video = msg.video || msg.video_note;
    if (!video) return null;

    let localPath: string | null = null;
    let audioPath: string | null = null;
    const framePaths: string[] = [];

    try {
      localPath = await this.bot.downloadFile(video.file_id, this.tempDir);
      const duration = video.duration || 0;

      log("info", "telegram.bot_handler.video.downloaded", {
        role: this.roleConfig.name,
        fileSize: video.file_size,
        duration,
      });

      const baseName = localPath.replace(/\.[^.]+$/, "");

      // === 音轨：提取 MP3 → Whisper STT ===
      audioPath = baseName + "_audio.mp3";
      let audioTranscript: string | null = null;
      try {
        execFileSync("ffmpeg", ["-y", "-i", localPath, "-vn", "-ar", "16000", "-ac", "1", "-b:a", "64k", audioPath], {
          stdio: "ignore"
        });

        const sttBaseUrl = process.env.MININGLAMP_GATEWAY_BASE_URL || "https://llm-guard.mininglamp.com";
        const sttApiKey = process.env.MININGLAMP_GATEWAY_API_KEY || process.env.LLM_GATEWAY_API_KEY || "";
        const sttModel = process.env.MININGLAMP_GATEWAY_STT_MODEL || "whisper-1";

        const formData = new FormData();
        formData.append("file", new Blob([fs.readFileSync(audioPath)], { type: "audio/mpeg" }), "audio.mp3");
        formData.append("model", sttModel);
        formData.append("language", "zh");

        const sttResp = await fetch(`${sttBaseUrl}/v1/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${sttApiKey}` },
          body: formData
        });

        if (sttResp.ok) {
          const sttData = await sttResp.json() as { text?: string };
          audioTranscript = sttData.text?.trim() || null;
        }
      } catch {
        // 音轨提取失败不中断流程
      }

      // === 画面：ffmpeg 抽帧 → base64 data URI → Vision API ===
      // 使用 base64 避免公网 URL 依赖（frpc 对外访问不稳定）
      const frameCount = Math.min(3, Math.max(1, Math.floor(duration / 5) + 1));
      const framePattern = baseName + "_frame_%d.jpg";
      let visualDescription: string | null = null;
      try {
        execFileSync("ffmpeg", [
          "-y", "-i", localPath,
          "-vf", `fps=1/${Math.max(1, Math.floor(duration / frameCount))},scale=640:-1`,
          "-vframes", String(frameCount),
          "-q:v", "5",
          framePattern
        ], { stdio: "ignore" });

        const imageContents: Array<{ type: "image_url"; image_url: { url: string } }> = [];
        for (let i = 1; i <= frameCount; i++) {
          const framePath = baseName + `_frame_${i}.jpg`;
          if (fs.existsSync(framePath)) {
            framePaths.push(framePath);
            const base64 = fs.readFileSync(framePath).toString("base64");
            imageContents.push({
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${base64}` }
            });
          }
        }

        log("info", "telegram.bot_handler.video.frames_ready", {
          role: this.roleConfig.name,
          frameCount,
          framesFound: imageContents.length,
          totalBase64Bytes: imageContents.reduce((s, c) => s + c.image_url.url.length, 0)
        });

        if (imageContents.length > 0) {
          // Vision API 处理图片较慢，使用独立的长超时客户端（默认 30s 不够）
          const { LLMGatewayClient } = await import("../llm/gateway-client.js");
          const visionClient = new LLMGatewayClient({ timeout: 120000 });
          const visionResp = await visionClient.chatCompletion({
            model: MULTIMODAL_MODEL,
            messages: [{
              role: "user",
              content: [
                ...imageContents,
                { type: "text", text: "详细描述这些视频关键帧中的所有物品、人物、场景和细节。" }
              ]
            }],
            max_tokens: 4000
          });
          visualDescription = visionResp?.choices?.[0]?.message?.content?.trim() || null;
          if (!visualDescription) {
            log("warn", "telegram.bot_handler.video.vision_empty", {
              role: this.roleConfig.name,
              hasResponse: !!visionResp,
              choicesCount: visionResp?.choices?.length ?? 0,
              rawContent: visionResp?.choices?.[0]?.message?.content ?? "(null)"
            });
          }
        }
      } catch (visualErr) {
        log("warn", "telegram.bot_handler.video.visual_failed", {
          role: this.roleConfig.name,
          error: String(visualErr)
        });
      }

      // === 合并结果 ===
      const parts: string[] = [];
      if (audioTranscript) parts.push(`【语音内容】${audioTranscript}`);
      if (visualDescription) parts.push(`【画面内容】${visualDescription}`);

      const result = parts.length > 0 ? parts.join("\n\n") : null;

      if (result) {
        log("info", "telegram.bot_handler.video.understood", {
          role: this.roleConfig.name,
          hasAudio: !!audioTranscript,
          hasVisual: !!visualDescription,
          resultLength: result.length,
          resultPreview: result.substring(0, 150)
        });
      } else {
        log("warn", "telegram.bot_handler.video.understanding_failed", { role: this.roleConfig.name });
      }

      return result;
    } catch (error) {
      log("error", "telegram.bot_handler.video.error", {
        role: this.roleConfig.name,
        error: String(error)
      });
      return null;
    } finally {
      if (localPath) { try { fs.unlinkSync(localPath); } catch {} }
      if (audioPath) { try { fs.unlinkSync(audioPath); } catch {} }
      for (const fp of framePaths) { try { fs.unlinkSync(fp); } catch {} }
    }
  }

  /**
   * 处理文档消息：下载 → 提取文本 → 返回 { filename, text }
   */
  private async processDocument(msg: TelegramBot.Message): Promise<{ filename: string; text: string } | null> {
    const doc = msg.document;
    if (!doc) return null;

    let localPath: string | null = null;
    try {
      localPath = await this.bot.downloadFile(doc.file_id, this.tempDir);
      const filename = doc.file_name || "unknown";

      log("info", "telegram.bot_handler.document.downloaded", {
        role: this.roleConfig.name,
        filename,
        fileSize: doc.file_size,
        mimeType: doc.mime_type,
        path: localPath
      });

      const result = await extractText(localPath);

      if (result.ok) {
        log("info", "telegram.bot_handler.document.extracted", {
          role: this.roleConfig.name,
          filename,
          textLength: result.text.length
        });
        return { filename, text: result.text };
      } else {
        log("warn", "telegram.bot_handler.document.extract_failed", {
          role: this.roleConfig.name,
          filename,
          reason: result.reason
        });
        return null;
      }
    } catch (error) {
      log("error", "telegram.bot_handler.document.error", {
        role: this.roleConfig.name,
        error: String(error)
      });
      return null;
    } finally {
      if (localPath) {
        try { fs.unlinkSync(localPath); } catch {}
      }
    }
  }

  /**
   * 处理图片消息：获取文件链接 → Vision API 理解 → 返回描述文本
   */
  private async processPhoto(msg: TelegramBot.Message): Promise<string | null> {
    const photos = msg.photo;
    if (!photos || photos.length === 0) return null;

    try {
      // 取最大尺寸的图片（数组最后一个）
      const largest = photos[photos.length - 1];
      const fileLink = await this.bot.getFileLink(largest.file_id);

      log("info", "telegram.bot_handler.photo.processing", {
        role: this.roleConfig.name,
        fileSize: largest.file_size,
        width: largest.width,
        height: largest.height,
        url: fileLink
      });

      const description = await MediaProcessor.getInstance().understandImage(fileLink);

      if (description) {
        log("info", "telegram.bot_handler.photo.understood", {
          role: this.roleConfig.name,
          descriptionLength: description.length
        });
        return description;
      } else {
        log("warn", "telegram.bot_handler.photo.vision_failed", {
          role: this.roleConfig.name
        });
        return null;
      }
    } catch (error) {
      log("error", "telegram.bot_handler.photo.error", {
        role: this.roleConfig.name,
        error: String(error)
      });
      return null;
    }
  }

  /**
   * 观察对话并决定是否参与
   */
  private async observeAndDecide(triggerMsg: TelegramBot.Message): Promise<void> {
    const numericChatId = triggerMsg.chat.id;
    const chatId = String(numericChatId);

    log("info", "telegram.bot_handler.observation.start", {
      role: this.roleConfig.name,
      chatId
    });

    // 从 conversationStore 获取历史（替代 Discord 的 getRecentChannelHistory）
    let history = this.conversationStore.getHistory(
      chatId,
      this.roleConfig.maxObservationMessages || 10,
      triggerMsg.message_id
    );

    if (history.length === 0) {
      log("debug", "telegram.bot_handler.observation.no_history", {
        role: this.roleConfig.name
      });
      return;
    }

    // 格式化对话历史
    const formattedHistory = formatConversationHistory(history);

    log("debug", "telegram.bot_handler.observation.history", {
      role: this.roleConfig.name,
      messageCount: history.length,
      historyLength: formattedHistory.length
    });

    // 话题去重：提取话题摘要
    const latestUserMessage = history
      .slice()
      .reverse()
      .find(msg => !msg.isBot);

    let currentTopicSummary = "";
    if (latestUserMessage) {
      currentTopicSummary = latestUserMessage.content.substring(0, 200);
    } else {
      currentTopicSummary = formattedHistory.substring(0, 200);
    }

    // 话题判断
    if (currentTopicSummary) {
      const topicChanged = await this.isTopicChanged(chatId, currentTopicSummary);

      if (!topicChanged) {
        log("info", "telegram.bot_handler.observation.topic_unchanged", {
          role: this.roleConfig.name,
          chatId,
          reason: "same_topic"
        });
        return;
      }
    }

    // 在 AI 参与判断之前，刷新历史（可能有 expert 已经回复）
    const refreshedHistory = this.conversationStore.getHistory(
      chatId,
      this.roleConfig.maxObservationMessages || 10,
      triggerMsg.message_id
    );

    if (refreshedHistory.length > 0) {
      history = refreshedHistory;
    }

    const latestFormattedHistory = formatConversationHistory(history);

    // AI 决策是否参与
    const decision = await aiDecideParticipation(
      this.agent,
      this.roleConfig,
      latestFormattedHistory
    );

    if (!decision.shouldParticipate) {
      log("info", "telegram.bot_handler.observation.declined", {
        role: this.roleConfig.name,
        reason: decision.reason
      });
      return;
    }

    log("info", "telegram.bot_handler.observation.participating", {
      role: this.roleConfig.name,
      chatId
    });

    // refreshBeforeReply：发言前再次刷新历史
    if (this.roleConfig.refreshBeforeReply) {
      const finalHistory = this.conversationStore.getHistory(
        chatId,
        this.roleConfig.maxObservationMessages || 10,
        triggerMsg.message_id
      );

      if (finalHistory.length > 0) {
        history = finalHistory;
        log("debug", "telegram.bot_handler.observation.final_refresh", {
          role: this.roleConfig.name,
          messageCount: finalHistory.length
        });
      }
    }

    // 构造提示词
    const finalFormattedHistory = formatConversationHistory(history);
    const fullPrompt = `${finalFormattedHistory}\n\n---\n\n你是【${this.roleConfig.name}】，${this.roleConfig.description}。请从你的角色出发，对上述对话进行回应。`;

    try {
      const response = await this.agent.reply(fullPrompt, {
        userId: "system",
        userName: this.roleConfig.name,
        channelId: `telegram:${chatId}`,
        agentId: this.config.agentId
      });

      // XML 标签过滤
      let cleanedResponse = this.filterXmlTags(response);

      if (!cleanedResponse) {
        cleanedResponse = "抱歉，我的回复包含了一些技术细节，已被过滤。请重新提问，我会给您一个更清晰的答复。";
      }

      // 记录 bot 回复到 conversationStore
      this.conversationStore.recordMessage(chatId, this.roleConfig.name, cleanedResponse, true);

      // 发送回复（带角色前缀）
      const prefixedResponse = `**${this.roleConfig.name}的观点：**\n\n${cleanedResponse}`;
      await this.sendReply(numericChatId, prefixedResponse);

      // 记录话题参与
      this.recentParticipations.set(chatId, {
        topicSummary: currentTopicSummary || "unknown",
        timestamp: Date.now()
      });

      log("info", "telegram.bot_handler.observation.participated", {
        role: this.roleConfig.name,
        responseLength: response.length,
        topicSummary: currentTopicSummary.substring(0, 50) || "unknown"
      });
    } catch (error) {
      log("error", "telegram.bot_handler.observation.reply_failed", {
        role: this.roleConfig.name,
        error: String(error)
      });
    }
  }

  /**
   * AI 判断话题是否改变（含哈希缓存优化）
   */
  private async isTopicChanged(chatId: string, currentTopicSummary: string): Promise<boolean> {
    const lastParticipation = this.recentParticipations.get(chatId);

    if (!lastParticipation) return true;

    if (Date.now() - lastParticipation.timestamp > this.maxParticipationAge) {
      return true;
    }

    // 哈希缓存
    const currentHash = crypto.createHash("md5").update(currentTopicSummary).digest("hex");
    const cached = this.topicCache.get(chatId);

    if (cached && Date.now() - cached.timestamp < this.topicCacheTTL) {
      if (cached.hash === currentHash) {
        log("debug", "telegram.bot_handler.topic_cache.hit", {
          role: this.roleConfig.name,
          chatId
        });
        return false;
      }
    }

    // AI 判断
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

      if (!isYes && !isNo) {
        return false; // 保守策略：不参与
      }

      // 更新缓存
      this.topicCache.set(chatId, { hash: currentHash, timestamp: Date.now() });

      return isYes;
    } catch (error) {
      log("error", "telegram.bot_handler.topic_check.failed", {
        role: this.roleConfig.name,
        error: String(error)
      });
      return false;
    }
  }

  /**
   * 过滤 XML 标签
   */
  private filterXmlTags(text: string): string {
    const original = text;
    let cleaned = text
      .replace(/^\[skill:[^\]]+\]\n?/i, "")
      .replace(TelegramBotHandler.XML_TAG_PAIR_REGEX, '')
      .replace(TelegramBotHandler.XML_TAG_SINGLE_REGEX, '')
      .trim();

    if (cleaned.length !== original.length) {
      log("warn", "telegram.bot_handler.xml_tags_filtered", {
        role: this.roleConfig.name,
        originalLength: original.length,
        cleanedLength: cleaned.length,
        removedBytes: original.length - cleaned.length
      });
    }

    return cleaned;
  }

  /**
   * 发送消息到 Telegram（分段 + Markdown 回退纯文本）
   */
  private async sendReply(chatId: number, text: string, replyToMessageId?: number): Promise<void> {
    const chunks = splitTextIntoChunks(text.trim() || "已处理完成。", {
      maxLength: TELEGRAM_MESSAGE_LIMIT
    });

    for (const chunk of chunks) {
      try {
        await withTimeout(
          this.bot.sendMessage(chatId, chunk, {
            reply_to_message_id: replyToMessageId,
            parse_mode: "Markdown"
          }),
          SEND_TIMEOUT_MS
        );
      } catch {
        // Markdown 解析失败时回退到纯文本
        try {
          await withTimeout(
            this.bot.sendMessage(chatId, chunk, {
              reply_to_message_id: replyToMessageId
            }),
            SEND_TIMEOUT_MS
          );
        } catch (plainError) {
          log("error", "telegram.bot_handler.send.failed", {
            role: this.roleConfig.name,
            chatId,
            error: String(plainError)
          });
        }
      }
      // 第一条之后不需要 reply_to
      replyToMessageId = undefined;
    }
  }

  /**
   * 启动定期清理
   */
  private startPeriodicCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.performCleanup();
    }, this.cleanupIntervalMs);
    this.cleanupInterval.unref();
  }

  /**
   * 执行清理操作
   */
  private performCleanup(): void {
    const now = Date.now();

    // 清理过期的参与记录
    let cleanedParticipations = 0;
    for (const [chatId, record] of this.recentParticipations.entries()) {
      if (now - record.timestamp > this.maxParticipationAge) {
        this.recentParticipations.delete(chatId);
        cleanedParticipations++;
      }
    }

    // 清理过期的话题缓存
    let cleanedTopicCache = 0;
    for (const [chatId, record] of this.topicCache.entries()) {
      if (now - record.timestamp > this.topicCacheTTL) {
        this.topicCache.delete(chatId);
        cleanedTopicCache++;
      }
    }

    // 缓存超限时删除最旧的
    if (this.topicCache.size > this.MAX_TOPIC_CACHE_SIZE) {
      const entries = Array.from(this.topicCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toDelete = entries.slice(0, this.topicCache.size - this.MAX_TOPIC_CACHE_SIZE);
      toDelete.forEach(([key]) => this.topicCache.delete(key));
      cleanedTopicCache += toDelete.length;
    }

    // 清理过期的消息队列
    let cleanedMessages = 0;
    const MESSAGE_MAX_AGE = 5 * 60 * 1000;
    this.messageQueue = this.messageQueue.filter(item => {
      if (now - item.timestamp > MESSAGE_MAX_AGE) {
        cleanedMessages++;
        return false;
      }
      return true;
    });

    // 清理超时的观察任务
    let cleanedTasks = 0;
    for (const [chatId, task] of this.observationTasks.entries()) {
      const maxAge = this.roleConfig.observationDelay + 60000;
      if (now - task.startTime > maxAge) {
        clearTimeout(task.timer);
        this.observationTasks.delete(chatId);
        cleanedTasks++;
      }
    }

    // 清理超过 1 小时的临时附件文件
    let cleanedTempFiles = 0;
    const TEMP_FILE_MAX_AGE = 3600000;
    try {
      const files = fs.readdirSync(this.tempDir);
      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > TEMP_FILE_MAX_AGE) {
            fs.unlinkSync(filePath);
            cleanedTempFiles++;
          }
        } catch {}
      }
    } catch {}

    if (cleanedParticipations > 0 || cleanedTopicCache > 0 || cleanedTasks > 0 || cleanedMessages > 0 || cleanedTempFiles > 0) {
      log("debug", "telegram.bot_handler.cleanup", {
        role: this.roleConfig.name,
        cleanedParticipations,
        cleanedTopicCache,
        cleanedTasks,
        cleanedMessages,
        cleanedTempFiles,
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
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    for (const task of this.observationTasks.values()) {
      clearTimeout(task.timer);
    }
    this.observationTasks.clear();
    this.recentParticipations.clear();

    log("info", "telegram.bot_handler.cleanup.complete", {
      role: this.roleConfig.name
    });
  }
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
