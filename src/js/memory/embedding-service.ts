/**
 * Embedding服务 - 向量化引擎
 * 支持多种embedding provider：OpenAI、Anthropic、本地模型、简单哈希
 */

import { createHash } from "node:crypto";
import { ProxyAgent } from "undici";
import { log, logError } from "../shared/logger.js";
import { JPClawError, ErrorCode } from "../shared/errors.js";
import { metrics } from "../monitoring/metrics.js";

export type EmbeddingProvider = "openai" | "anthropic" | "local" | "simple";

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  dimensions?: number;
  timeout?: number;
  maxRetries?: number;
  cacheTTL?: number;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  usage?: {
    promptTokens: number;
    totalTokens: number;
  };
  cached: boolean;
}

export class EmbeddingService {
  private static instance: EmbeddingService;
  private config: Required<EmbeddingConfig>;
  private cache = new Map<string, { embedding: number[]; timestamp: number; model: string }>();
  private requestQueue: Array<() => Promise<void>> = [];
  private isProcessingQueue = false;
  private proxyAgent: ProxyAgent | null = null;

  private constructor(config?: Partial<EmbeddingConfig>) {
    // 默认配置 - 默认使用simple embedding（免费、无需API key）
    this.config = {
      provider: (process.env.JPCLAW_EMBEDDING_PROVIDER as EmbeddingProvider) || "simple",  // ← 改为默认simple
      model: process.env.JPCLAW_EMBEDDING_MODEL || "text-embedding-3-small",
      apiKey: process.env.OPENAI_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "",
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      dimensions: parseInt(process.env.JPCLAW_EMBEDDING_DIMENSIONS || "384"),
      timeout: parseInt(process.env.JPCLAW_EMBEDDING_TIMEOUT || "30000"),
      maxRetries: parseInt(process.env.JPCLAW_EMBEDDING_MAX_RETRIES || "3"),
      cacheTTL: parseInt(process.env.JPCLAW_EMBEDDING_CACHE_TTL || "86400000"), // 24小时
      ...config
    };

    // 如果没有API key且不是simple模式，回退到simple
    if (!this.config.apiKey && this.config.provider !== "simple") {
      log("warn", "No API key found, falling back to simple embedding", {
        requestedProvider: this.config.provider
      });
      this.config.provider = "simple";
    }

    // 配置代理（如果需要）
    const proxyUrl =
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy;

    if (proxyUrl) {
      try {
        this.proxyAgent = new ProxyAgent(proxyUrl);
        log("info", "Proxy agent configured for embedding service", { proxyUrl });
      } catch (error) {
        log("warn", "Failed to create proxy agent", {
          proxyUrl,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // 定期清理过期缓存
    setInterval(() => {
      this.cleanupCache();
    }, 10 * 60 * 1000); // 每 10 分钟清理一次

    log("info", "Embedding service initialized", {
      provider: this.config.provider,
      model: this.config.model,
      dimensions: this.config.dimensions,
      hasApiKey: !!this.config.apiKey,
      hasProxy: !!this.proxyAgent,
      cacheTTL: this.config.cacheTTL,
      cacheCleanupInterval: "10 minutes"
    });
  }

  static getInstance(config?: Partial<EmbeddingConfig>): EmbeddingService {
    if (!EmbeddingService.instance) {
      EmbeddingService.instance = new EmbeddingService(config);
    }
    return EmbeddingService.instance;
  }

  /**
   * 获取文本的embedding向量
   */
  async getEmbedding(text: string, options?: { skipCache?: boolean }): Promise<EmbeddingResult> {
    const startTime = Date.now();

    try {
      // 生成缓存key
      const cacheKey = this.generateCacheKey(text);

      // 检查缓存
      if (!options?.skipCache) {
        const cached = this.getCachedEmbedding(cacheKey);
        if (cached) {
          metrics.increment("memory.embedding.cache_hit", 1, {
            provider: this.config.provider
          });

          return {
            embedding: cached.embedding,
            model: cached.model,
            cached: true
          };
        }
      }

      // 根据provider生成embedding
      let embedding: number[];
      let model = this.config.model;
      let usage: EmbeddingResult["usage"] | undefined;

      switch (this.config.provider) {
        case "openai":
          ({ embedding, model, usage } = await this.getOpenAIEmbedding(text));
          break;
        case "anthropic":
          ({ embedding, model, usage } = await this.getAnthropicEmbedding(text));
          break;
        case "local":
          ({ embedding, model } = await this.getLocalEmbedding(text));
          break;
        case "simple":
        default:
          embedding = this.generateSimpleEmbedding(text);
          model = "simple-hash";
          break;
      }

      // 验证embedding维度
      if (embedding.length !== this.config.dimensions) {
        log("warn", "Embedding dimension mismatch", {
          expected: this.config.dimensions,
          actual: embedding.length,
          model
        });

        // 调整维度
        embedding = this.adjustDimensions(embedding, this.config.dimensions);
      }

      // 缓存结果
      this.cacheEmbedding(cacheKey, embedding, model);

      const duration = Date.now() - startTime;

      metrics.timing("memory.embedding.duration", duration, {
        provider: this.config.provider,
        model
      });

      metrics.increment("memory.embedding.generated", 1, {
        provider: this.config.provider,
        model
      });

      log("debug", "Embedding generated", {
        provider: this.config.provider,
        model,
        textLength: text.length,
        dimensions: embedding.length,
        duration,
        cached: false
      });

      return {
        embedding,
        model,
        usage,
        cached: false
      };

    } catch (error) {
      const duration = Date.now() - startTime;

      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: `Failed to generate embedding with ${this.config.provider}`,
        cause: error instanceof Error ? error : undefined
      }));

      metrics.increment("memory.embedding.error", 1, {
        provider: this.config.provider,
        error: error instanceof Error ? error.message : String(error)
      });

      // 回退到简单embedding
      if (this.config.provider !== "simple") {
        log("warn", "Falling back to simple embedding due to error", {
          originalProvider: this.config.provider,
          error: error instanceof Error ? error.message : String(error)
        });

        const simpleEmbedding = this.generateSimpleEmbedding(text);
        return {
          embedding: simpleEmbedding,
          model: "simple-hash-fallback",
          cached: false
        };
      }

      throw error;
    }
  }

  /**
   * 批量获取embeddings
   */
  async getBatchEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
    const startTime = Date.now();

    try {
      // 检查是否支持批量API
      if (this.config.provider === "openai" && texts.length > 1) {
        return await this.getOpenAIBatchEmbeddings(texts);
      }

      // 顺序处理
      const results: EmbeddingResult[] = [];
      for (const text of texts) {
        const result = await this.getEmbedding(text);
        results.push(result);
      }

      const duration = Date.now() - startTime;

      log("info", "Batch embeddings generated", {
        count: texts.length,
        duration,
        avgDuration: duration / texts.length
      });

      return results;

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to generate batch embeddings",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 获取图片的embedding向量（用于多模态记忆）
   */
  async getImageEmbedding(imageBuffer: Buffer, options?: { skipCache?: boolean }): Promise<EmbeddingResult> {
    const startTime = Date.now();

    try {
      // 生成缓存key
      const cacheKey = this.generateImageCacheKey(imageBuffer);

      // 检查缓存
      if (!options?.skipCache) {
        const cached = this.getCachedEmbedding(cacheKey);
        if (cached) {
          metrics.increment("memory.image_embedding.cache_hit", 1, {
            provider: this.config.provider
          });

          return {
            embedding: cached.embedding,
            model: cached.model,
            cached: true
          };
        }
      }

      // 根据provider生成图片embedding
      let embedding: number[];
      let model = this.config.model;

      if (this.config.provider === "openai" && this.config.apiKey) {
        try {
          ({ embedding, model } = await this.getOpenAIImageEmbedding(imageBuffer));
        } catch (error) {
          log("warn", "OpenAI image embedding failed, falling back to simple", {
            error: error instanceof Error ? error.message : String(error)
          });
          embedding = this.generateSimpleImageEmbedding(imageBuffer);
          model = "simple-image-hash-fallback";
        }
      } else {
        // 使用简单图片哈希作为fallback
        embedding = this.generateSimpleImageEmbedding(imageBuffer);
        model = "simple-image-hash";
      }

      // 验证embedding维度
      if (embedding.length !== this.config.dimensions) {
        log("warn", "Image embedding dimension mismatch", {
          expected: this.config.dimensions,
          actual: embedding.length,
          model
        });

        // 调整维度
        embedding = this.adjustDimensions(embedding, this.config.dimensions);
      }

      // 缓存结果
      this.cacheEmbedding(cacheKey, embedding, model);

      const duration = Date.now() - startTime;

      metrics.timing("memory.image_embedding.duration", duration, {
        provider: this.config.provider,
        model
      });

      metrics.increment("memory.image_embedding.generated", 1, {
        provider: this.config.provider,
        model
      });

      log("debug", "Image embedding generated", {
        provider: this.config.provider,
        model,
        bufferSize: imageBuffer.length,
        dimensions: embedding.length,
        duration,
        cached: false
      });

      return {
        embedding,
        model,
        cached: false
      };

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: `Failed to generate image embedding`,
        cause: error instanceof Error ? error : undefined
      }));

      metrics.increment("memory.image_embedding.error", 1, {
        provider: this.config.provider,
        error: error instanceof Error ? error.message : String(error)
      });

      // 最终fallback
      const simpleEmbedding = this.generateSimpleImageEmbedding(imageBuffer);
      return {
        embedding: simpleEmbedding,
        model: "simple-image-hash-fallback",
        cached: false
      };
    }
  }

  /**
   * OpenAI Embeddings API
   */
  private async getOpenAIEmbedding(text: string): Promise<{
    embedding: number[];
    model: string;
    usage?: { promptTokens: number; totalTokens: number };
  }> {
    const url = `${this.config.baseUrl}/embeddings`;

    const response = await this.fetchWithRetry(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.model,
        input: text,
        dimensions: this.config.dimensions
      })
    });

    const data = await response.json();

    if (!data.data || !data.data[0] || !data.data[0].embedding) {
      throw new Error("Invalid OpenAI embedding response");
    }

    return {
      embedding: data.data[0].embedding,
      model: data.model,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        totalTokens: data.usage.total_tokens
      } : undefined
    };
  }

  /**
   * OpenAI批量embeddings
   */
  private async getOpenAIBatchEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
    const url = `${this.config.baseUrl}/embeddings`;

    const response = await this.fetchWithRetry(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.model,
        input: texts,
        dimensions: this.config.dimensions
      })
    });

    const data = await response.json();

    if (!data.data || !Array.isArray(data.data)) {
      throw new Error("Invalid OpenAI batch embedding response");
    }

    return data.data.map((item: any, index: number) => {
      const cacheKey = this.generateCacheKey(texts[index]);
      this.cacheEmbedding(cacheKey, item.embedding, data.model);

      return {
        embedding: item.embedding,
        model: data.model,
        cached: false
      };
    });
  }

  /**
   * Anthropic Embeddings (通过Messages API模拟)
   * 注意：Anthropic目前没有专门的embeddings API，这里使用文本相似度作为替代
   */
  private async getAnthropicEmbedding(text: string): Promise<{
    embedding: number[];
    model: string;
    usage?: { promptTokens: number; totalTokens: number };
  }> {
    // Anthropic没有embedding API，回退到simple
    log("warn", "Anthropic doesn't have native embedding API, falling back to simple", {
      text: text.slice(0, 50)
    });

    return {
      embedding: this.generateSimpleEmbedding(text),
      model: "simple-hash-anthropic-fallback"
    };
  }

  /**
   * 本地embedding模型（预留接口）
   * 可以集成transformers.js或onnxruntime
   */
  private async getLocalEmbedding(text: string): Promise<{
    embedding: number[];
    model: string;
  }> {
    // TODO: 集成本地模型
    // 例如：@xenova/transformers, onnxruntime-node等

    log("warn", "Local embedding not implemented yet, falling back to simple", {
      text: text.slice(0, 50)
    });

    return {
      embedding: this.generateSimpleEmbedding(text),
      model: "simple-hash-local-fallback"
    };
  }

  /**
   * OpenAI图片Embedding API（使用CLIP模型）
   * 注意：OpenAI目前的embeddings API主要支持文本，这里使用的是CLIP模型的假设接口
   * 如果OpenAI未来提供专门的图片embedding API，可以更新此方法
   */
  private async getOpenAIImageEmbedding(imageBuffer: Buffer): Promise<{
    embedding: number[];
    model: string;
  }> {
    // 将图片转为base64
    const base64Image = imageBuffer.toString('base64');

    // 注意：OpenAI当前可能不直接支持图片embedding
    // 这里使用Vision API的逻辑提取图片特征
    // 实际实现可能需要调整
    const url = `${this.config.baseUrl}/embeddings`;

    try {
      const response = await this.fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify({
          model: process.env.JPCLAW_IMAGE_EMBEDDING_MODEL || "clip-vit-base-patch32",
          input: `data:image/jpeg;base64,${base64Image}`,
          encoding_format: "float"
        })
      });

      const data = await response.json();

      if (!data.data || !data.data[0] || !data.data[0].embedding) {
        throw new Error("Invalid OpenAI image embedding response");
      }

      return {
        embedding: data.data[0].embedding,
        model: data.model
      };
    } catch (error) {
      // OpenAI可能不支持图片embedding，记录警告并抛出错误以fallback
      log("warn", "OpenAI image embedding API not available or failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * 改进的简单embedding（基于多哈希词袋模型）
   * 使用多个哈希函数将词映射到向量空间，提高语义相似度检测能力
   */
  private generateSimpleEmbedding(text: string): number[] {
    const dimensions = this.config.dimensions;
    const embedding = new Array(dimensions).fill(0);

    // 参数验证
    if (!text || typeof text !== 'string') {
      log("warn", "Invalid text for simple embedding", { text: String(text) });
      return embedding;  // 返回零向量
    }

    // 1. 分词：中文按字符，英文按单词，数字保留
    const tokens: string[] = [];

    // 提取中文字符
    const chineseChars = text.match(/[\u4e00-\u9fa5]/g) || [];
    tokens.push(...chineseChars);

    // 提取英文单词（转小写）
    const englishWords = text.toLowerCase().match(/[a-z]+/g) || [];
    tokens.push(...englishWords);

    // 提取数字
    const numbers = text.match(/\d+/g) || [];
    tokens.push(...numbers);

    if (tokens.length === 0) {
      return embedding;
    }

    // 2. 词频统计
    const tokenFreq = new Map<string, number>();
    for (const token of tokens) {
      tokenFreq.set(token, (tokenFreq.get(token) || 0) + 1);
    }

    // 3. 使用4个不同的哈希函数将每个词映射到向量空间
    // 这样即使两个文本用词不完全相同，只要有重叠词就能有相似度
    const hashSeeds = [17, 31, 47, 97];  // 4个质数作为哈希种子

    for (const [token, freq] of tokenFreq.entries()) {
      // TF权重：使用log平滑
      const tfWeight = 1 + Math.log(freq);

      // 使用多个哈希函数
      for (const seed of hashSeeds) {
        let hash = seed;
        for (let i = 0; i < token.length; i++) {
          hash = ((hash << 5) - hash + token.charCodeAt(i)) & 0xffffffff;
        }

        const index = Math.abs(hash) % dimensions;
        embedding[index] += tfWeight;
      }
    }

    // 4. 添加bi-gram特征（增强上下文感知）
    for (let i = 0; i < tokens.length - 1; i++) {
      const bigram = tokens[i] + tokens[i + 1];

      let hash = 13;  // 另一个质数种子
      for (let j = 0; j < bigram.length; j++) {
        hash = ((hash << 5) - hash + bigram.charCodeAt(j)) & 0xffffffff;
      }

      const index = Math.abs(hash) % dimensions;
      embedding[index] += 0.5;  // bi-gram权重较低
    }

    // 5. L2归一化
    const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    if (norm > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= norm;
      }
    }

    return embedding;
  }

  /**
   * 简单图片哈希embedding（fallback实现）
   * 基于图片内容的SHA256哈希生成向量
   */
  private generateSimpleImageEmbedding(imageBuffer: Buffer): number[] {
    const dimensions = this.config.dimensions;
    const embedding = new Array(dimensions).fill(0);

    // 方法1：基于SHA256哈希
    const hash = createHash('sha256').update(imageBuffer).digest();
    for (let i = 0; i < Math.min(hash.length, dimensions); i++) {
      embedding[i] = (hash[i] / 255) * 2 - 1;  // 归一化到 [-1, 1]
    }

    // 方法2：添加图片大小特征
    const sizeFeature = Math.log(imageBuffer.length + 1) / 20;  // 归一化的大小特征
    for (let i = 0; i < dimensions; i += 8) {
      if (i < dimensions) {
        embedding[i] = (embedding[i] + sizeFeature) / 2;
      }
    }

    // 方法3：基于字节分布的统计特征
    const byteDistribution = new Array(256).fill(0);
    for (let i = 0; i < imageBuffer.length; i++) {
      byteDistribution[imageBuffer[i]]++;
    }

    // 提取前N个主要字节值
    const topBytes = byteDistribution
      .map((count, byte) => ({ byte, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, dimensions / 4);

    for (let i = 0; i < topBytes.length && i < dimensions / 4; i++) {
      const idx = i * 4;
      if (idx < dimensions) {
        const normalized = (topBytes[i].byte / 255) * 2 - 1;
        embedding[idx] = (embedding[idx] + normalized) / 2;
      }
    }

    // 归一化到单位向量
    const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    if (norm > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= norm;
      }
    }

    return embedding;
  }

  /**
   * HTTP请求重试包装
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    retries = 0
  ): Promise<Response> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      const fetchOptions: any = {
        ...options,
        signal: controller.signal
      };

      // 如果有proxy agent，使用它作为dispatcher
      if (this.proxyAgent) {
        fetchOptions.dispatcher = this.proxyAgent;
      }

      const response = await fetch(url, fetchOptions);

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response;

    } catch (error) {
      if (retries < this.config.maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, retries), 10000);

        log("warn", "Embedding API request failed, retrying", {
          url,
          attempt: retries + 1,
          maxRetries: this.config.maxRetries,
          delay,
          error: error instanceof Error ? error.message : String(error)
        });

        await new Promise(resolve => setTimeout(resolve, delay));
        return this.fetchWithRetry(url, options, retries + 1);
      }

      throw error;
    }
  }

  /**
   * 调整embedding维度
   */
  private adjustDimensions(embedding: number[], targetDimensions: number): number[] {
    if (embedding.length === targetDimensions) {
      return embedding;
    }

    if (embedding.length > targetDimensions) {
      // 截断
      return embedding.slice(0, targetDimensions);
    }

    // 补零
    return [...embedding, ...new Array(targetDimensions - embedding.length).fill(0)];
  }

  /**
   * 生成缓存key
   */
  private generateCacheKey(text: string): string {
    const hash = createHash("sha256")
      .update(`${this.config.provider}:${this.config.model}:${text}`)
      .digest("hex");
    return hash.slice(0, 32);
  }

  /**
   * 生成图片缓存key
   */
  private generateImageCacheKey(imageBuffer: Buffer): string {
    const hash = createHash("sha256")
      .update(`image:${this.config.provider}:${this.config.model}:`)
      .update(imageBuffer)
      .digest("hex");
    return hash.slice(0, 32);
  }

  /**
   * 获取缓存的embedding
   */
  private getCachedEmbedding(cacheKey: string): { embedding: number[]; model: string } | null {
    const cached = this.cache.get(cacheKey);

    if (!cached) {
      return null;
    }

    // 检查是否过期
    if (Date.now() - cached.timestamp > this.config.cacheTTL) {
      this.cache.delete(cacheKey);
      return null;
    }

    return {
      embedding: cached.embedding,
      model: cached.model
    };
  }

  /**
   * 缓存embedding
   */
  private cacheEmbedding(cacheKey: string, embedding: number[], model: string): void {
    this.cache.set(cacheKey, {
      embedding,
      model,
      timestamp: Date.now()
    });

    // 限制缓存大小 - 降低最大缓存数量以减少内存占用
    const maxCacheSize = 5000; // 从 10000 降低到 5000
    const cleanupSize = 1000;  // 每次清理 1000 个

    if (this.cache.size > maxCacheSize) {
      // 删除最旧的缓存（Map 的迭代顺序是插入顺序）
      const keys = Array.from(this.cache.keys());
      for (let i = 0; i < cleanupSize; i++) {
        this.cache.delete(keys[i]);
      }

      log("debug", "Embedding cache size limit reached, cleaned up old entries", {
        before: maxCacheSize + cleanupSize,
        after: this.cache.size,
        removed: cleanupSize
      });
    }
  }

  /**
   * 清理过期缓存
   */
  cleanupCache(): void {
    const now = Date.now();
    let removed = 0;

    for (const [key, cached] of this.cache.entries()) {
      if (now - cached.timestamp > this.config.cacheTTL) {
        this.cache.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      log("debug", "Embedding cache cleaned up", { removed, remaining: this.cache.size });
    }
  }

  /**
   * 获取统计信息
   */
  getStatistics(): {
    provider: EmbeddingProvider;
    model: string;
    cacheSize: number;
    cacheHitRate?: number;
  } {
    return {
      provider: this.config.provider,
      model: this.config.model,
      cacheSize: this.cache.size
    };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<EmbeddingConfig>): void {
    const oldProvider = this.config.provider;

    this.config = {
      ...this.config,
      ...config
    };

    // 如果provider变化，清空缓存
    if (config.provider && config.provider !== oldProvider) {
      this.cache.clear();
      log("info", "Embedding provider changed, cache cleared", {
        from: oldProvider,
        to: config.provider
      });
    }
  }
}

// 导出getInstance方法以支持延迟初始化
// 不要在模块加载时创建实例，因为环境变量可能还未加载
let _globalInstance: EmbeddingService | null = null;

export const embeddingService = {
  getEmbedding: async (text: string, options?: { skipCache?: boolean }): Promise<EmbeddingResult> => {
    if (!_globalInstance) {
      _globalInstance = EmbeddingService.getInstance();
    }
    return _globalInstance.getEmbedding(text, options);
  },
  getBatchEmbeddings: async (texts: string[]): Promise<EmbeddingResult[]> => {
    if (!_globalInstance) {
      _globalInstance = EmbeddingService.getInstance();
    }
    return _globalInstance.getBatchEmbeddings(texts);
  },
  getImageEmbedding: async (imageBuffer: Buffer, options?: { skipCache?: boolean }): Promise<EmbeddingResult> => {
    if (!_globalInstance) {
      _globalInstance = EmbeddingService.getInstance();
    }
    return _globalInstance.getImageEmbedding(imageBuffer, options);
  },
  getStatistics: (): { provider: string; model: string; cacheSize: number } => {
    if (!_globalInstance) {
      _globalInstance = EmbeddingService.getInstance();
    }
    return _globalInstance.getStatistics();
  },
  cleanupCache: (): void => {
    if (!_globalInstance) {
      _globalInstance = EmbeddingService.getInstance();
    }
    _globalInstance.cleanupCache();
  }
};
