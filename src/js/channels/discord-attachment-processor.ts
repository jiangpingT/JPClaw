/**
 * Discord 附件处理器（公共类）
 *
 * 统一处理 Discord 消息的所有附件类型：
 * - 语音附件：下载 → 转录 → 返回文本
 * - 文档附件：下载 → 提取文本 → 返回内容
 * - 图片附件：返回 URL（供后续 OCR/图像识别）
 *
 * 核心特性：
 * - ✅ 代理支持（Discord WebSocket/REST 统一代理）
 * - ✅ 重试机制（指数退避）
 * - ✅ 超时控制
 * - ✅ 自动清理临时文件
 */

import path from "node:path";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Message, Attachment } from "discord.js";
import { ProxyAgent } from "undici";
import { log } from "../shared/logger.js";
import { MediaProcessor } from "../media/processor.js";
import { extractText } from "./document-text-extractor.js";
import { validateFileName } from "../shared/security-utils.js";

export interface AttachmentProcessorOptions {
  /** Discord 代理 URL（可选） */
  proxyUrl?: string;

  /** 下载重试次数（默认3次） */
  downloadRetries?: number;

  /** 下载超时时间（毫秒，默认30秒） */
  downloadTimeout?: number;

  /** 临时文件目录（默认 tmp/discord-attachments） */
  tempDir?: string;
}

export interface ProcessedAttachments {
  /** 语音转录文本（如果有语音附件） */
  voiceTranscript?: string;

  /** 文档内容（如果有文档附件） */
  documents?: Array<{
    filename: string;
    text: string;
    size: number;
  }>;

  /** 图片信息（如果有图片附件） */
  images?: Array<{
    filename: string;
    url: string;
    contentType?: string;
  }>;

  /** 图片理解结果（如果有图片附件并成功理解） */
  imageDescriptions?: Array<{
    filename: string;
    description: string;
  }>;
}

export type AttachmentType = 'voice' | 'document' | 'image' | 'other';

/**
 * Discord 附件处理器
 */
export class DiscordAttachmentProcessor {
  private readonly proxyAgent?: ProxyAgent;
  private readonly downloadRetries: number;
  private readonly downloadTimeout: number;
  private readonly tempDir: string;

  /** 音频文件扩展名 */
  private readonly audioExts = [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".webm"];

  /** 文档文件扩展名 */
  private readonly documentExts = [".txt", ".md", ".pdf", ".json", ".csv", ".log", ".doc", ".docx"];

  /** 图片文件扩展名 */
  private readonly imageExts = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"];

  constructor(options: AttachmentProcessorOptions = {}) {
    if (options.proxyUrl) {
      this.proxyAgent = new ProxyAgent(options.proxyUrl);
      log("info", "discord.attachment_processor.proxy_enabled", { proxyUrl: options.proxyUrl });
    }

    this.downloadRetries = options.downloadRetries ?? 3;
    this.downloadTimeout = options.downloadTimeout ?? 30000;
    this.tempDir = options.tempDir ?? path.resolve(process.cwd(), "tmp", "discord-attachments");

    // 确保临时目录存在
    mkdirSync(this.tempDir, { recursive: true });
  }

  /**
   * 检测附件类型
   */
  detectAttachmentType(attachment: Attachment): AttachmentType {
    const ext = path.extname(attachment.name || "").toLowerCase();
    const contentType = attachment.contentType?.toLowerCase() || "";

    // 优先检查 contentType
    if (contentType.startsWith("audio/") || this.audioExts.includes(ext)) {
      return 'voice';
    }

    if (contentType.startsWith("image/") || this.imageExts.includes(ext)) {
      return 'image';
    }

    if (this.documentExts.includes(ext) || contentType.includes("text") || contentType.includes("pdf")) {
      return 'document';
    }

    return 'other';
  }

  /**
   * 下载附件到临时文件（带重试、超时、代理支持）
   */
  async downloadAttachment(
    url: string,
    filename: string,
    retries?: number
  ): Promise<string> {
    // P1-9修复: 验证文件名，防止路径遍历攻击
    const safeFilename = validateFileName(filename) ? filename : `file_${Date.now()}${path.extname(filename)}`;

    const maxRetries = retries ?? this.downloadRetries;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const tempFile = path.join(this.tempDir, `${Date.now()}_${safeFilename}`);
      let file: ReturnType<typeof createWriteStream> | null = null;

      try {
        // 使用 fetch API 下载（支持代理）
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.downloadTimeout);

        const response = await fetch(url, {
          signal: controller.signal,
          // @ts-ignore - undici 的 dispatcher 选项
          dispatcher: this.proxyAgent
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        if (!response.body) {
          throw new Error("Response body is null");
        }

        // 将响应流写入文件
        file = createWriteStream(tempFile);
        await pipeline(Readable.fromWeb(response.body as any), file);

        // 下载成功
        log("info", "discord.attachment.downloaded", {
          path: tempFile,
          attempt,
          size: statSync(tempFile).size,
          useProxy: !!this.proxyAgent
        });

        return tempFile;

      } catch (err) {
        // 清理失败的文件
        try {
          if (file) {
            file.close();
          }
          if (existsSync(tempFile)) {
            unlinkSync(tempFile);
          }
        } catch {}

        if (attempt < maxRetries) {
          log("warn", "discord.attachment.download.retry", {
            attempt,
            maxRetries,
            error: err instanceof Error ? err.message : String(err),
            useProxy: !!this.proxyAgent
          });

          // 等待后重试（指数退避：1s → 2s → 4s）
          await new Promise(resolve =>
            setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt - 1), 5000))
          );
        } else {
          // 最后一次重试失败
          log("error", "discord.attachment.download.failed", {
            error: err instanceof Error ? err.message : String(err),
            url,
            useProxy: !!this.proxyAgent
          });
          throw err;
        }
      }
    }

    throw new Error("Download failed after all retries");
  }

  /**
   * 处理语音附件 → 返回转录文本
   */
  async processVoiceAttachment(message: Message): Promise<string | null> {
    try {
      // 检查是否有附件
      if (!message.attachments || message.attachments.size === 0) {
        return null;
      }

      // 查找音频附件
      let audioAttachment: Attachment | null = null;

      for (const [, attachment] of message.attachments) {
        if (this.detectAttachmentType(attachment) === 'voice') {
          audioAttachment = attachment;
          break;
        }
      }

      if (!audioAttachment) {
        return null;
      }

      log("info", "discord.voice.attachment.detected", {
        filename: audioAttachment.name,
        size: audioAttachment.size,
        contentType: audioAttachment.contentType
      });

      // 下载附件
      const localPath = await this.downloadAttachment(
        audioAttachment.url,
        audioAttachment.name || "voice.ogg"
      );

      log("info", "discord.voice.attachment.downloaded", { path: localPath });

      // 转录音频
      const mediaProcessor = MediaProcessor.getInstance();
      const transcript = await mediaProcessor.transcribeAudio(localPath);

      // 清理临时文件
      try {
        rmSync(localPath);
      } catch (e) {
        // 忽略清理错误
      }

      if (transcript) {
        log("info", "discord.voice.transcription.success", {
          transcriptLength: transcript.length
        });
        return transcript;
      } else {
        log("warn", "discord.voice.transcription.failed");
        return null;
      }
    } catch (error) {
      log("error", "discord.voice.processing.error", { error: String(error) });
      return null;
    }
  }

  /**
   * 处理文档附件 → 返回文本内容
   */
  async processDocumentAttachment(message: Message): Promise<Array<{
    filename: string;
    text: string;
    size: number;
  }> | null> {
    try {
      // 检查是否有附件
      if (!message.attachments || message.attachments.size === 0) {
        return null;
      }

      // 查找文档附件
      const documentAttachments: Attachment[] = [];

      for (const [, attachment] of message.attachments) {
        if (this.detectAttachmentType(attachment) === 'document') {
          documentAttachments.push(attachment);
        }
      }

      if (documentAttachments.length === 0) {
        return null;
      }

      log("info", "discord.document.attachments.detected", {
        count: documentAttachments.length,
        files: documentAttachments.map(a => a.name)
      });

      // 处理所有文档
      const results: Array<{ filename: string; text: string; size: number }> = [];

      for (const attachment of documentAttachments) {
        try {
          // 下载文档
          const localPath = await this.downloadAttachment(
            attachment.url,
            attachment.name || "document.txt"
          );

          log("info", "discord.document.attachment.downloaded", {
            filename: attachment.name,
            path: localPath
          });

          // 提取文本
          const extracted = await extractText(localPath);

          // 清理临时文件
          try {
            rmSync(localPath);
          } catch {}

          if (extracted.ok) {
            results.push({
              filename: attachment.name || "unknown",
              text: extracted.text,
              size: attachment.size
            });

            log("info", "discord.document.text.extracted", {
              filename: attachment.name,
              textLength: extracted.text.length
            });
          } else {
            log("warn", "discord.document.text.extraction_failed", {
              filename: attachment.name,
              reason: extracted.reason
            });
          }
        } catch (error) {
          log("error", "discord.document.processing.error", {
            filename: attachment.name,
            error: String(error)
          });
        }
      }

      return results.length > 0 ? results : null;
    } catch (error) {
      log("error", "discord.document.processing.error", { error: String(error) });
      return null;
    }
  }

  /**
   * 处理图片附件 → 返回 URL 信息（供后续 OCR/图像识别）
   */
  async processImageAttachment(message: Message): Promise<Array<{
    filename: string;
    url: string;
    contentType?: string;
  }> | null> {
    try {
      // 检查是否有附件
      if (!message.attachments || message.attachments.size === 0) {
        return null;
      }

      // 查找图片附件
      const imageAttachments: Attachment[] = [];

      for (const [, attachment] of message.attachments) {
        if (this.detectAttachmentType(attachment) === 'image') {
          imageAttachments.push(attachment);
        }
      }

      if (imageAttachments.length === 0) {
        return null;
      }

      log("info", "discord.image.attachments.detected", {
        count: imageAttachments.length,
        files: imageAttachments.map(a => a.name)
      });

      return imageAttachments.map(attachment => ({
        filename: attachment.name || "image",
        url: attachment.url,
        contentType: attachment.contentType || undefined
      }));
    } catch (error) {
      log("error", "discord.image.processing.error", { error: String(error) });
      return null;
    }
  }

  /**
   * 理解所有图片附件的内容（使用 MediaProcessor）
   */
  async understandAllImages(message: Message): Promise<Array<{
    filename: string;
    description: string;
  }> | null> {
    try {
      const images = await this.processImageAttachment(message);
      if (!images || images.length === 0) {
        return null;
      }

      const descriptions: Array<{ filename: string; description: string }> = [];
      const mediaProcessor = MediaProcessor.getInstance();

      for (const image of images) {
        log("info", "discord.image.vision.processing", {
          filename: image.filename,
          url: image.url
        });

        // 调用 MediaProcessor 的统一图片理解接口
        const description = await mediaProcessor.understandImage(image.url);

        if (description) {
          descriptions.push({
            filename: image.filename,
            description
          });

          log("info", "discord.image.vision.completed", {
            filename: image.filename,
            descriptionLength: description.length
          });
        } else {
          log("warn", "discord.image.vision.skipped", {
            filename: image.filename
          });
        }
      }

      return descriptions.length > 0 ? descriptions : null;
    } catch (error) {
      log("error", "discord.image.vision.batch_error", { error: String(error) });
      return null;
    }
  }

  /**
   * 统一处理消息的所有附件
   */
  async processAllAttachments(message: Message): Promise<ProcessedAttachments> {
    const result: ProcessedAttachments = {};

    // 记录附件处理开始（简化信息，不暴露 URL）
    if (message.attachments && message.attachments.size > 0) {
      log("debug", "discord.attachment.processing.start", {
        count: message.attachments.size,
        types: Array.from(message.attachments.values()).map(a => ({
          name: a.name,
          contentType: a.contentType,
          size: a.size
        }))
      });
    }

    // 语音优先（如果有语音，忽略其他附件）
    const voiceTranscript = await this.processVoiceAttachment(message);
    if (voiceTranscript) {
      result.voiceTranscript = voiceTranscript;
      return result; // 语音附件处理后直接返回
    }

    // 处理文档附件
    const documents = await this.processDocumentAttachment(message);
    if (documents) {
      result.documents = documents;
    }

    // 处理图片附件（返回 URL 信息）
    const images = await this.processImageAttachment(message);
    if (images) {
      result.images = images;
    }

    // 理解图片内容（调用明略多模态网关）
    const imageDescriptions = await this.understandAllImages(message);
    if (imageDescriptions) {
      result.imageDescriptions = imageDescriptions;
    }

    return result;
  }

  /**
   * 清理旧的临时文件（超过1小时的）
   */
  cleanupOldTempFiles(): void {
    try {
      if (!existsSync(this.tempDir)) {
        return;
      }

      const now = Date.now();
      const maxAge = 3600000; // 1小时

      const files = readdirSync(this.tempDir);
      let cleaned = 0;

      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        try {
          const stats = statSync(filePath);
          if (now - stats.mtimeMs > maxAge) {
            rmSync(filePath);
            cleaned++;
          }
        } catch {}
      }

      if (cleaned > 0) {
        log("info", "discord.attachment.cleanup", {
          cleaned,
          tempDir: this.tempDir
        });
      }
    } catch (error) {
      log("warn", "discord.attachment.cleanup.failed", { error: String(error) });
    }
  }
}
