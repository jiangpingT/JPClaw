/**
 * 多媒体处理系统
 * 提供图片、音频、视频和文档的处理能力
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { log, logError } from "../shared/logger.js";
import { JPClawError, ErrorCode } from "../shared/errors.js";
import { metrics } from "../monitoring/metrics.js";
import { Converter } from "opencc-js";
import { getDefaultGatewayClient } from "../llm/gateway-client.js";

export type MediaType = "image" | "audio" | "video" | "document" | "unknown";

export interface MediaInfo {
  id: string;
  filename: string;
  type: MediaType;
  mimeType: string;
  size: number;
  hash: string;
  metadata: Record<string, unknown>;
  processedAt: number;
  thumbnailPath?: string;
  transcriptPath?: string;
  extractedText?: string;
}

export interface ProcessingOptions {
  generateThumbnail?: boolean;
  extractText?: boolean;
  extractAudio?: boolean;
  transcribeAudio?: boolean;
  quality?: "low" | "medium" | "high";
  maxSize?: number;
  format?: string;
}

export interface ProcessingResult {
  success: boolean;
  mediaInfo?: MediaInfo;
  thumbnailPath?: string;
  extractedText?: string;
  transcript?: string;
  errors: string[];
  processingTime: number;
}

export class MediaProcessor {
  private static instance: MediaProcessor;
  private mediaDirectory: string;
  private tempDirectory: string;
  private cacheDirectory: string;
  private traditionalToSimplified: any;

  private constructor() {
    this.mediaDirectory = path.resolve(process.cwd(), "sessions", "media");
    this.tempDirectory = path.resolve(process.cwd(), "tmp", "media");
    this.cacheDirectory = path.resolve(process.cwd(), "sessions", "media_cache");

    // 初始化繁简转换器（繁体 -> 简体）
    this.traditionalToSimplified = Converter({ from: 'tw', to: 'cn' });

    // 确保目录存在
    fs.mkdirSync(this.mediaDirectory, { recursive: true });
    fs.mkdirSync(this.tempDirectory, { recursive: true });
    fs.mkdirSync(this.cacheDirectory, { recursive: true });
  }

  static getInstance(): MediaProcessor {
    if (!MediaProcessor.instance) {
      MediaProcessor.instance = new MediaProcessor();
    }
    return MediaProcessor.instance;
  }

  /**
   * 处理上传的媒体文件
   */
  async processMedia(
    filePath: string,
    filename: string,
    options: ProcessingOptions = {}
  ): Promise<ProcessingResult> {
    const startTime = Date.now();
    const result: ProcessingResult = {
      success: false,
      errors: [],
      processingTime: 0
    };

    try {
      // 验证文件
      if (!fs.existsSync(filePath)) {
        result.errors.push("File not found");
        return result;
      }

      const stats = fs.statSync(filePath);
      if (options.maxSize && stats.size > options.maxSize) {
        result.errors.push(`File size exceeds limit: ${stats.size} > ${options.maxSize}`);
        return result;
      }

      // 检测文件类型
      const mediaType = await this.detectMediaType(filePath, filename);
      const mimeType = this.getMimeType(filename);

      // 生成唯一ID和哈希
      const fileContent = fs.readFileSync(filePath);
      const hash = createHash('sha256').update(fileContent).digest('hex');
      const id = `${hash.slice(0, 16)}_${Date.now()}`;

      // 检查缓存
      const cachedInfo = await this.getCachedMediaInfo(hash);
      if (cachedInfo) {
        result.success = true;
        result.mediaInfo = cachedInfo;
        result.processingTime = Date.now() - startTime;
        return result;
      }

      // 保存原始文件
      const storedPath = await this.storeMediaFile(filePath, id, filename);

      // 创建媒体信息
      const mediaInfo: MediaInfo = {
        id,
        filename,
        type: mediaType,
        mimeType,
        size: stats.size,
        hash,
        metadata: {},
        processedAt: Date.now()
      };

      // 根据媒体类型进行处理
      await this.processMediaByType(mediaInfo, storedPath, options, result);

      // 缓存结果
      await this.cacheMediaInfo(mediaInfo);

      result.success = true;
      result.mediaInfo = mediaInfo;

      log("info", "Media processed successfully", {
        id: mediaInfo.id,
        type: mediaInfo.type,
        size: mediaInfo.size,
        processingTime: Date.now() - startTime
      });

      metrics.increment("media.processed", 1, {
        type: mediaType,
        size_mb: Math.round(stats.size / 1024 / 1024).toString()
      });

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.SYSTEM_INTERNAL,
        message: "Media processing failed",
        cause: error instanceof Error ? error : undefined
      }));

      result.errors.push(error instanceof Error ? error.message : String(error));
    } finally {
      result.processingTime = Date.now() - startTime;
    }

    return result;
  }

  /**
   * 获取媒体信息
   */
  async getMediaInfo(mediaId: string): Promise<MediaInfo | null> {
    const infoPath = path.join(this.mediaDirectory, `${mediaId}.json`);
    
    if (!fs.existsSync(infoPath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(infoPath, 'utf-8');
      return JSON.parse(content) as MediaInfo;
    } catch (error) {
      log("warn", "Failed to load media info", {
        mediaId,
        error: String(error)
      });
      return null;
    }
  }

  /**
   * 获取媒体文件路径
   */
  getMediaPath(mediaId: string, filename: string): string {
    return path.join(this.mediaDirectory, `${mediaId}_${filename}`);
  }

  /**
   * 生成缩略图
   */
  async generateThumbnail(
    inputPath: string,
    mediaType: MediaType,
    quality: "low" | "medium" | "high" = "medium"
  ): Promise<string | null> {
    const thumbnailId = createHash('md5').update(inputPath + quality).digest('hex');
    const thumbnailPath = path.join(this.cacheDirectory, `thumb_${thumbnailId}.jpg`);

    if (fs.existsSync(thumbnailPath)) {
      return thumbnailPath;
    }

    try {
      switch (mediaType) {
        case "image":
          return await this.generateImageThumbnail(inputPath, thumbnailPath, quality);
        case "video":
          return await this.generateVideoThumbnail(inputPath, thumbnailPath, quality);
        case "document":
          return await this.generateDocumentThumbnail(inputPath, thumbnailPath, quality);
        default:
          return null;
      }
    } catch (error) {
      log("warn", "Failed to generate thumbnail", {
        inputPath,
        mediaType,
        error: String(error)
      });
      return null;
    }
  }

  /**
   * 提取文本内容
   */
  async extractText(filePath: string, mediaType: MediaType): Promise<string | null> {
    try {
      switch (mediaType) {
        case "document":
          return await this.extractDocumentText(filePath);
        case "image":
          return await this.extractImageText(filePath);
        default:
          return null;
      }
    } catch (error) {
      log("warn", "Failed to extract text", {
        filePath,
        mediaType,
        error: String(error)
      });
      return null;
    }
  }

  /**
   * 转录音频
   */
  async transcribeAudio(audioPath: string): Promise<string | null> {
    try {
      // 检查是否有可用的转录服务
      const whisperAvailable = await this.checkWhisperAvailability();
      
      if (whisperAvailable) {
        return await this.transcribeWithWhisper(audioPath);
      }

      // 备用：使用其他转录服务
      return await this.transcribeWithFallback(audioPath);
    } catch (error) {
      log("warn", "Failed to transcribe audio", {
        audioPath,
        error: String(error)
      });
      return null;
    }
  }

  private async detectMediaType(filePath: string, filename: string): Promise<MediaType> {
    const ext = path.extname(filename).toLowerCase();
    
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
    const audioExts = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];
    const videoExts = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv'];
    const docExts = ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.odt'];

    if (imageExts.includes(ext)) {
      return "image";
    } else if (audioExts.includes(ext)) {
      return "audio";
    } else if (videoExts.includes(ext)) {
      return "video";
    } else if (docExts.includes(ext)) {
      return "document";
    }

    // 尝试通过文件头检测
    try {
      const buffer = fs.readFileSync(filePath);
      const header = buffer.subarray(0, 8).toString('hex').toUpperCase();

      // 常见文件头签名
      const signatures: Record<string, MediaType> = {
        '89504E47': 'image',  // PNG
        'FFD8FF': 'image',    // JPEG
        '47494638': 'image',  // GIF
        '52494646': 'audio',  // WAV/AVI
        '494433': 'audio',    // MP3
        '25504446': 'document' // PDF
      };

      for (const [sig, type] of Object.entries(signatures)) {
        if (header.startsWith(sig)) {
          return type;
        }
      }
    } catch (error) {
      log("warn", "Failed to detect media type from header", {
        filePath,
        error: String(error)
      });
    }

    return "unknown";
  }

  private getMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.m4a': 'audio/mp4',
      '.aac': 'audio/aac',
      '.flac': 'audio/flac',
      '.mp4': 'video/mp4',
      '.avi': 'video/avi',
      '.mov': 'video/quicktime',
      '.wmv': 'video/x-ms-wmv',
      '.flv': 'video/x-flv',
      '.webm': 'video/webm',
      '.mkv': 'video/x-matroska',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain',
      '.rtf': 'application/rtf',
      '.odt': 'application/vnd.oasis.opendocument.text'
    };

    return mimeTypes[ext] || 'application/octet-stream';
  }

  private async storeMediaFile(filePath: string, id: string, filename: string): Promise<string> {
    const targetPath = path.join(this.mediaDirectory, `${id}_${filename}`);
    fs.copyFileSync(filePath, targetPath);
    return targetPath;
  }

  private async processMediaByType(
    mediaInfo: MediaInfo,
    storedPath: string,
    options: ProcessingOptions,
    result: ProcessingResult
  ): Promise<void> {
    switch (mediaInfo.type) {
      case "image":
        await this.processImage(mediaInfo, storedPath, options, result);
        break;
      case "audio":
        await this.processAudio(mediaInfo, storedPath, options, result);
        break;
      case "video":
        await this.processVideo(mediaInfo, storedPath, options, result);
        break;
      case "document":
        await this.processDocument(mediaInfo, storedPath, options, result);
        break;
    }
  }

  private async processImage(
    mediaInfo: MediaInfo,
    storedPath: string,
    options: ProcessingOptions,
    result: ProcessingResult
  ): Promise<void> {
    // 生成缩略图
    if (options.generateThumbnail) {
      const thumbnailPath = await this.generateThumbnail(storedPath, "image", options.quality);
      if (thumbnailPath) {
        mediaInfo.thumbnailPath = thumbnailPath;
        result.thumbnailPath = thumbnailPath;
      }
    }

    // 提取图片中的文本 (OCR)
    if (options.extractText) {
      const extractedText = await this.extractText(storedPath, "image");
      if (extractedText) {
        mediaInfo.extractedText = extractedText;
        result.extractedText = extractedText;
      }
    }

    // 提取图片元数据
    mediaInfo.metadata = await this.extractImageMetadata(storedPath);
  }

  private async processAudio(
    mediaInfo: MediaInfo,
    storedPath: string,
    options: ProcessingOptions,
    result: ProcessingResult
  ): Promise<void> {
    // 转录音频
    if (options.transcribeAudio) {
      const transcript = await this.transcribeAudio(storedPath);
      if (transcript) {
        const transcriptPath = path.join(this.cacheDirectory, `transcript_${mediaInfo.id}.txt`);
        fs.writeFileSync(transcriptPath, transcript);
        mediaInfo.transcriptPath = transcriptPath;
        result.transcript = transcript;
      }
    }

    // 提取音频元数据
    mediaInfo.metadata = await this.extractAudioMetadata(storedPath);
  }

  private async processVideo(
    mediaInfo: MediaInfo,
    storedPath: string,
    options: ProcessingOptions,
    result: ProcessingResult
  ): Promise<void> {
    // 生成视频缩略图
    if (options.generateThumbnail) {
      const thumbnailPath = await this.generateThumbnail(storedPath, "video", options.quality);
      if (thumbnailPath) {
        mediaInfo.thumbnailPath = thumbnailPath;
        result.thumbnailPath = thumbnailPath;
      }
    }

    // 提取音频并转录
    if (options.transcribeAudio || options.extractAudio) {
      const audioPath = await this.extractVideoAudio(storedPath, mediaInfo.id);
      if (audioPath && options.transcribeAudio) {
        const transcript = await this.transcribeAudio(audioPath);
        if (transcript) {
          const transcriptPath = path.join(this.cacheDirectory, `transcript_${mediaInfo.id}.txt`);
          fs.writeFileSync(transcriptPath, transcript);
          mediaInfo.transcriptPath = transcriptPath;
          result.transcript = transcript;
        }
      }
    }

    // 提取视频元数据
    mediaInfo.metadata = await this.extractVideoMetadata(storedPath);
  }

  private async processDocument(
    mediaInfo: MediaInfo,
    storedPath: string,
    options: ProcessingOptions,
    result: ProcessingResult
  ): Promise<void> {
    // 生成文档缩略图
    if (options.generateThumbnail) {
      const thumbnailPath = await this.generateThumbnail(storedPath, "document", options.quality);
      if (thumbnailPath) {
        mediaInfo.thumbnailPath = thumbnailPath;
        result.thumbnailPath = thumbnailPath;
      }
    }

    // 提取文档文本
    if (options.extractText) {
      const extractedText = await this.extractText(storedPath, "document");
      if (extractedText) {
        mediaInfo.extractedText = extractedText;
        result.extractedText = extractedText;
      }
    }

    // 提取文档元数据
    mediaInfo.metadata = await this.extractDocumentMetadata(storedPath);
  }

  private async generateImageThumbnail(
    inputPath: string,
    outputPath: string,
    quality: string
  ): Promise<string | null> {
    const sizes = { low: "150x150", medium: "300x300", high: "600x600" };
    const size = sizes[quality as keyof typeof sizes] || sizes.medium;

    // 尝试使用 ImageMagick
    if (await this.checkCommandAvailability("convert")) {
      return new Promise((resolve, reject) => {
        const proc = spawn("convert", [
          inputPath,
          "-resize", size + "^",
          "-gravity", "center",
          "-extent", size,
          outputPath
        ]);

        proc.on("close", (code) => {
          if (code === 0) {
            resolve(outputPath);
          } else {
            reject(new Error(`ImageMagick failed with code ${code}`));
          }
        });
      });
    }

    // 备用：简单复制（需要改进）
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }

  private async generateVideoThumbnail(
    inputPath: string,
    outputPath: string,
    quality: string
  ): Promise<string | null> {
    // 尝试使用 FFmpeg
    if (await this.checkCommandAvailability("ffmpeg")) {
      return new Promise((resolve, reject) => {
        const proc = spawn("ffmpeg", [
          "-i", inputPath,
          "-vframes", "1",
          "-an",
          "-s", quality === "high" ? "640x480" : "320x240",
          "-y",
          outputPath
        ]);

        proc.on("close", (code) => {
          if (code === 0) {
            resolve(outputPath);
          } else {
            reject(new Error(`FFmpeg failed with code ${code}`));
          }
        });
      });
    }

    return null;
  }

  private async generateDocumentThumbnail(
    inputPath: string,
    outputPath: string,
    quality: string
  ): Promise<string | null> {
    // 简化实现，实际应该使用 pdf2image 或类似工具
    return null;
  }

  private async extractImageText(imagePath: string): Promise<string | null> {
    // 尝试使用 Tesseract OCR
    if (await this.checkCommandAvailability("tesseract")) {
      return new Promise((resolve) => {
        const tempOutput = path.join(this.tempDirectory, `ocr_${Date.now()}`);

        const proc = spawn("tesseract", [imagePath, tempOutput]);

        proc.on("close", (code) => {
          try {
            const textPath = tempOutput + ".txt";
            if (fs.existsSync(textPath)) {
              const text = fs.readFileSync(textPath, 'utf-8');
              fs.unlinkSync(textPath);
              resolve(text.trim() || null);
            } else {
              resolve(null);
            }
          } catch (error) {
            resolve(null);
          }
        });
      });
    }

    return null;
  }

  /**
   * 使用 Vision API 理解图片内容（通过 LLM 网关）
   *
   * @param imagePathOrUrl - 图片的本地路径或URL
   * @param options - 可选配置（prompt、model）
   * @returns 图片内容描述
   */
  async understandImage(
    imagePathOrUrl: string,
    options?: {
      /** 自定义提示词（用于不同场景：OCR优先、场景描述等） */
      prompt?: string;
      /** 指定模型（默认使用网关配置的模型） */
      model?: string;
    }
  ): Promise<string | null> {
    try {
      // 判断是本地路径还是URL
      let imageUrl: string;
      if (imagePathOrUrl.startsWith("http://") || imagePathOrUrl.startsWith("https://")) {
        imageUrl = imagePathOrUrl;
      } else {
        // 本地文件暂不支持（需要先上传或转base64）
        log("warn", "media.vision.local_file_not_supported", {
          path: imagePathOrUrl,
          suggestion: "Please provide image URL instead of local path"
        });
        return null;
      }

      log("info", "media.vision.processing", {
        hasCustomPrompt: !!options?.prompt,
        model: options?.model
      });

      // 使用统一的 LLM 网关客户端
      const gatewayClient = getDefaultGatewayClient();
      const description = await gatewayClient.understandImage(
        imageUrl,
        options?.prompt,
        options?.model
      );

      if (description) {
        log("info", "media.vision.success", {
          descriptionLength: description.length
        });
        return description;
      }

      log("warn", "media.vision.empty_response");
      return null;
    } catch (error) {
      log("error", "media.vision.error", {
        error: String(error)
      });
      return null;
    }
  }

  private async extractDocumentText(docPath: string): Promise<string | null> {
    const ext = path.extname(docPath).toLowerCase();
    
    if (ext === '.txt') {
      return fs.readFileSync(docPath, 'utf-8');
    }
    
    if (ext === '.pdf') {
      // 尝试使用 pdftotext
      if (await this.checkCommandAvailability("pdftotext")) {
        return new Promise((resolve) => {
          const tempOutput = path.join(this.tempDirectory, `pdf_${Date.now()}.txt`);
          
          const proc = spawn("pdftotext", [docPath, tempOutput]);
          
          proc.on("close", (code) => {
            try {
              if (fs.existsSync(tempOutput)) {
                const text = fs.readFileSync(tempOutput, 'utf-8');
                fs.unlinkSync(tempOutput);
                resolve(text.trim() || null);
              } else {
                resolve(null);
              }
            } catch (error) {
              resolve(null);
            }
          });
        });
      }
    }

    return null;
  }

  private async transcribeWithWhisper(audioPath: string): Promise<string | null> {
    return new Promise((resolve) => {
      const outputDir = path.join(this.tempDirectory, `whisper_${Date.now()}`);
      fs.mkdirSync(outputDir, { recursive: true });

      // Whisper 输出文件名基于输入文件名（不带扩展名）
      const baseName = path.basename(audioPath, path.extname(audioPath));
      const expectedOutputPath = path.join(outputDir, `${baseName}.txt`);

      log("info", "Starting Whisper transcription", {
        audioPath,
        outputDir,
        expectedOutput: expectedOutputPath
      });

      // 使用完整路径，因为 launchd 的 PATH 可能不包含 conda 环境
      const whisperCmd = "/opt/homebrew/Caskroom/miniforge/base/bin/whisper";

      const proc = spawn(whisperCmd, [
        audioPath,
        "--model", "base",
        "--output_dir", outputDir,
        "--output_format", "txt",
        "--language", "zh",
        "--initial_prompt", "以下是普通话的句子。"  // 引导Whisper输出简体中文
      ]);

      // 收集错误输出
      let stderr = "";
      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        try {
          if (fs.existsSync(expectedOutputPath)) {
            const transcript = fs.readFileSync(expectedOutputPath, 'utf-8');

            // 清理临时文件和目录
            try {
              fs.rmSync(outputDir, { recursive: true, force: true });
            } catch {}

            const cleanedTranscript = transcript.trim();

            // 繁体转简体（兜底处理，配合initial_prompt使用）
            const simplifiedTranscript = this.traditionalToSimplified(cleanedTranscript);
            const wasConverted = cleanedTranscript !== simplifiedTranscript;

            log("info", "Whisper transcription completed", {
              transcriptLength: simplifiedTranscript.length,
              exitCode: code,
              needsConversion: wasConverted,
              originalText: wasConverted ? cleanedTranscript : undefined
            });

            resolve(simplifiedTranscript || null);
          } else {
            log("warn", "Whisper output file not found", {
              expectedPath: expectedOutputPath,
              exitCode: code,
              stderr: stderr.slice(0, 500)
            });

            // 清理临时目录
            try {
              fs.rmSync(outputDir, { recursive: true, force: true });
            } catch {}

            resolve(null);
          }
        } catch (error) {
          log("error", "Failed to read Whisper output", {
            error: String(error)
          });

          // 清理临时目录
          try {
            fs.rmSync(outputDir, { recursive: true, force: true });
          } catch {}

          resolve(null);
        }
      });

      proc.on("error", (error) => {
        log("error", "Whisper process error", {
          error: String(error)
        });

        // 清理临时目录
        try {
          fs.rmSync(outputDir, { recursive: true, force: true });
        } catch {}

        resolve(null);
      });
    });
  }

  private async transcribeWithFallback(audioPath: string): Promise<string | null> {
    // 备用转录方法，可以调用云服务API
    log("info", "Using fallback transcription method", { audioPath });
    return null;
  }

  private async extractVideoAudio(videoPath: string, mediaId: string): Promise<string | null> {
    if (await this.checkCommandAvailability("ffmpeg")) {
      const audioPath = path.join(this.tempDirectory, `audio_${mediaId}.wav`);
      
      return new Promise((resolve) => {
        const proc = spawn("ffmpeg", [
          "-i", videoPath,
          "-vn",
          "-acodec", "pcm_s16le",
          "-ar", "16000",
          "-ac", "1",
          "-y",
          audioPath
        ]);
        
        proc.on("close", (code) => {
          if (code === 0 && fs.existsSync(audioPath)) {
            resolve(audioPath);
          } else {
            resolve(null);
          }
        });
      });
    }

    return null;
  }

  private async extractImageMetadata(imagePath: string): Promise<Record<string, unknown>> {
    // 简化的元数据提取
    const stats = fs.statSync(imagePath);
    return {
      size: stats.size,
      modified: stats.mtime,
      // 实际实现中应该使用 exifread 或类似库提取 EXIF 信息
    };
  }

  private async extractAudioMetadata(audioPath: string): Promise<Record<string, unknown>> {
    const stats = fs.statSync(audioPath);
    return {
      size: stats.size,
      modified: stats.mtime,
      // 实际实现中应该提取音频时长、比特率等信息
    };
  }

  private async extractVideoMetadata(videoPath: string): Promise<Record<string, unknown>> {
    const stats = fs.statSync(videoPath);
    return {
      size: stats.size,
      modified: stats.mtime,
      // 实际实现中应该使用 ffprobe 提取视频信息
    };
  }

  private async extractDocumentMetadata(docPath: string): Promise<Record<string, unknown>> {
    const stats = fs.statSync(docPath);
    return {
      size: stats.size,
      modified: stats.mtime,
      // 实际实现中应该提取文档作者、创建时间等信息
    };
  }

  private async checkCommandAvailability(command: string): Promise<boolean> {
    return new Promise((resolve) => {
      // 使用 --help 参数，更通用
      const proc = spawn(command, ["--help"], { stdio: "ignore" });

      // 只要命令能执行就认为可用（不管退出码）
      let commandExecuted = false;
      proc.on("close", () => {
        resolve(commandExecuted);
      });
      proc.on("spawn", () => {
        commandExecuted = true;
      });
      proc.on("error", () => {
        resolve(false);
      });
    });
  }

  private async checkWhisperAvailability(): Promise<boolean> {
    // 使用完整路径，因为 launchd 的 PATH 可能不包含 conda 环境
    const whisperCmd = "/opt/homebrew/Caskroom/miniforge/base/bin/whisper";

    // 直接检查文件是否存在且可执行
    try {
      const fs = await import("node:fs/promises");
      await fs.access(whisperCmd, (await import("node:fs")).constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async getCachedMediaInfo(hash: string): Promise<MediaInfo | null> {
    const cachePath = path.join(this.cacheDirectory, `${hash}.json`);
    
    if (fs.existsSync(cachePath)) {
      try {
        const content = fs.readFileSync(cachePath, 'utf-8');
        return JSON.parse(content) as MediaInfo;
      } catch (error) {
        // 缓存损坏，删除
        fs.unlinkSync(cachePath);
      }
    }
    
    return null;
  }

  private async cacheMediaInfo(mediaInfo: MediaInfo): Promise<void> {
    const cachePath = path.join(this.cacheDirectory, `${mediaInfo.hash}.json`);
    fs.writeFileSync(cachePath, JSON.stringify(mediaInfo, null, 2));
    
    // 保存媒体信息到主目录
    const infoPath = path.join(this.mediaDirectory, `${mediaInfo.id}.json`);
    fs.writeFileSync(infoPath, JSON.stringify(mediaInfo, null, 2));
  }
}

// 导出全局实例
export const mediaProcessor = MediaProcessor.getInstance();