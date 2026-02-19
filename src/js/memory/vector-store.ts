/**
 * 向量化记忆存储系统
 * 支持语义检索和记忆嵌入
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { log, logError } from "../shared/logger.js";
import { JPClawError, ErrorCode } from "../shared/errors.js";
import { MEMORY_CONSTANTS, calculateTimeDecay } from "../shared/constants.js";
import { metrics } from "../monitoring/metrics.js";
import { embeddingService } from "./embedding-service.js";
import { vectorBM25Index } from "./vector-bm25-index.js";

/**
 * 多模态内容类型
 */
export type MultimodalType = 'text' | 'image' | 'audio' | 'video' | 'document';

/**
 * 统一的记忆向量接口（支持多模态）
 *
 * 设计理念：
 * - text/image 是核心存储类型
 * - audio/video/document 作为输入格式，降级为 text/image
 * - 只保留 textEmbedding 和 imageEmbedding（真正有价值的两种）
 */
export interface MemoryVector {
  id: string;
  content: string;

  // ========== 向量字段 ==========
  /** 主要embedding（通常是textEmbedding） */
  embedding: number[];

  /** 图片embedding（用于以图搜图） */
  imageEmbedding?: number[];

  // ========== 多模态内容字段 ==========
  /** OCR提取的文本（来自图片） */
  ocrText?: string;

  /** 音频/视频转录文本 */
  transcript?: string;

  metadata: {
    userId: string;
    type: "shortTerm" | "midTerm" | "longTerm" | "pinned" | "profile";
    timestamp: number;
    importance: number;
    category?: string;
    tags?: string[];

    // ========== 多模态元数据 ==========
    /** 多模态类型标记 */
    multimodalType?: MultimodalType;

    /** 原始文件路径 */
    originalPath?: string;

    /** MIME类型 */
    mimeType?: string;

    /** 文件大小（字节） */
    size?: number;

    /** 缩略图路径 */
    thumbnailPath?: string;
  };
  lastAccessed: number;
  accessCount: number;
}

export interface VectorSearchResult {
  vector: MemoryVector;
  similarity: number;
  rank: number;
}

export interface SemanticQuery {
  text: string;
  filters?: {
    userId?: string;
    type?: MemoryVector["metadata"]["type"];
    category?: string;
    tags?: string[];
    minImportance?: number;
    timeRange?: { from: number; to: number };
  };
  limit?: number;
  threshold?: number;
}

export class VectorMemoryStore {
  private static instance: VectorMemoryStore;
  private vectors = new Map<string, MemoryVector>();
  private userVectorIndex = new Map<string, Set<string>>();
  private vectorDirectory: string;
  private isDirty = false;
  private saveTimer?: NodeJS.Timeout;
  private static initializing = false;

  // 优化：使用Promise队列确保串行执行（替代不可靠的布尔互斥锁）
  private saveQueue: Promise<void> = Promise.resolve();

  private constructor() {
    this.vectorDirectory = path.resolve(process.cwd(), "sessions", "memory_vectors");
    fs.mkdirSync(this.vectorDirectory, { recursive: true });
    this.loadVectors();
  }

  /**
   * 优化：防止竞态条件的单例实现
   */
  static getInstance(): VectorMemoryStore {
    if (this.instance) {
      return this.instance;
    }

    // 防止重入
    if (this.initializing) {
      throw new Error("VectorMemoryStore is already being initialized. Please wait for initialization to complete.");
    }

    try {
      this.initializing = true;
      this.instance = new VectorMemoryStore();
      return this.instance;
    } finally {
      this.initializing = false;
    }
  }

  /**
   * 添加或更新记忆向量
   */
  async addMemory(
    content: string,
    metadata: MemoryVector["metadata"],
    importance: number = 0.5
  ): Promise<string> {
    try {
      const id = this.generateMemoryId(content, metadata.userId);
      const embedding = await this.getEmbedding(content);
      
      const vector: MemoryVector = {
        id,
        content: content.trim(),
        embedding,
        metadata: {
          ...metadata,
          importance: Math.max(0, Math.min(1, importance))
        },
        lastAccessed: Date.now(),
        accessCount: 1
      };

      // 如果已存在，保留访问统计
      const existing = this.vectors.get(id);
      if (existing) {
        vector.lastAccessed = existing.lastAccessed;
        vector.accessCount = existing.accessCount;
      }

      // P0-9修复：内存管理 - 检查用户向量数量限制
      const userId = metadata.userId;
      if (!this.userVectorIndex.has(userId)) {
        this.userVectorIndex.set(userId, new Set());
      }
      const userVectors = this.userVectorIndex.get(userId)!;

      // 如果是新向量且超过限制，自动淘汰旧向量
      const maxVectorsPerUser = MEMORY_CONSTANTS.VECTOR.DEFAULT_MAX_VECTORS_PER_USER;
      if (!existing && userVectors.size >= maxVectorsPerUser) {
        // 找出可以淘汰的向量（排除pinned类型）
        const vectorsToConsider = Array.from(userVectors)
          .map(vectorId => this.vectors.get(vectorId))
          .filter((v): v is MemoryVector => v !== undefined && v.metadata.type !== "pinned");

        if (vectorsToConsider.length > 0) {
          // P1-NEW-4修复: 使用统一常量计算淘汰评分
          const now = Date.now();
          const importanceWeight = MEMORY_CONSTANTS.VECTOR.EVICTION_IMPORTANCE_WEIGHT;
          const recencyWeight = MEMORY_CONSTANTS.VECTOR.EVICTION_RECENCY_WEIGHT;
          const maxAgeMs = MEMORY_CONSTANTS.VECTOR.DEFAULT_MAX_AGE_MS;
          const scored = vectorsToConsider.map(v => ({
            vector: v,
            score: v.metadata.importance * importanceWeight +
                   (1 - Math.min((now - v.lastAccessed) / maxAgeMs, 1)) * recencyWeight
          }));

          // 淘汰最低分的向量
          scored.sort((a, b) => a.score - b.score);
          const toRemove = scored[0].vector;

          log("info", "memory.vector.evicted", {
            userId,
            vectorId: toRemove.id,
            type: toRemove.metadata.type,
            importance: toRemove.metadata.importance,
            lastAccessed: new Date(toRemove.lastAccessed).toISOString()
          });

          this.removeMemory(toRemove.id);
          metrics.increment("memory.vector.evicted", 1, {
            type: toRemove.metadata.type,
            reason: "max_user_limit"
          });
        }
      }

      this.vectors.set(id, vector);
      userVectors.add(id);

      this.markDirty();

      log("debug", "Memory vector added", {
        id,
        userId: metadata.userId,
        type: metadata.type,
        contentLength: content.length
      });

      metrics.increment("memory.vector.added", 1, {
        type: metadata.type,
        userId: metadata.userId
      });

      // 同步索引到BM25（异步执行，不阻塞）
      vectorBM25Index.indexMemory(vector).catch(err => {
        logError(new JPClawError({
          code: ErrorCode.MEMORY_OPERATION_FAILED,
          message: "Failed to index memory to BM25",
          cause: err instanceof Error ? err : undefined
        }));
      });

      return id;
    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to add memory vector",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 根据ID获取记忆
   */
  getMemoryById(memoryId: string): MemoryVector | undefined {
    return this.vectors.get(memoryId);
  }

  /**
   * 语义搜索记忆
   */
  async searchMemories(query: SemanticQuery): Promise<VectorSearchResult[]> {
    try {
      const queryEmbedding = await this.getEmbedding(query.text);
      const candidates = this.filterCandidates(query.filters);
      
      if (candidates.length === 0) {
        return [];
      }

      // 优化：单次遍历计算similarity和compositeScore，减少中间对象创建
      const threshold = query.threshold || MEMORY_CONSTANTS.VECTOR.DEFAULT_SIMILARITY_THRESHOLD;
      const limit = query.limit || MEMORY_CONSTANTS.VECTOR.DEFAULT_MAX_RESULTS;

      // 计算所有候选的分数（只创建一次对象）
      const scoredResults: Array<{
        vector: MemoryVector;
        similarity: number;
        compositeScore: number;
        rank: number;
      }> = [];

      for (const vector of candidates) {
        const similarity = this.cosineSimilarity(queryEmbedding, vector.embedding);

        // 早期过滤：跳过低相似度结果
        if (similarity < threshold) continue;

        const compositeScore = this.calculateCompositeScore(vector, similarity, query.text);

        scoredResults.push({
          vector,
          similarity,
          compositeScore,
          rank: 0
        });
      }

      // 按复合分数排序
      scoredResults.sort((a, b) => b.compositeScore - a.compositeScore);

      // 取前N个结果，分配排名并更新访问统计
      const topResults = scoredResults.slice(0, limit);
      const results: VectorSearchResult[] = new Array(topResults.length);

      for (let i = 0; i < topResults.length; i++) {
        const result = topResults[i];
        result.rank = i + 1;

        // 更新访问统计
        result.vector.lastAccessed = Date.now();
        result.vector.accessCount++;

        results[i] = {
          vector: result.vector,
          similarity: result.similarity,
          rank: result.rank
        };
      }

      if (topResults.length > 0) {
        this.markDirty();
      }

      log("debug", "Memory search completed", {
        query: query.text.slice(0, 50),
        candidatesCount: candidates.length,
        resultsCount: results.length,
        threshold
      });

      metrics.increment("memory.vector.search", 1, {
        resultsCount: results.length.toString()
      });

      return results;
    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_RETRIEVAL_FAILED,
        message: "Failed to search memory vectors",
        cause: error instanceof Error ? error : undefined
      }));
      return [];
    }
  }

  /**
   * 获取用户的所有记忆
   */
  getUserMemories(userId: string): MemoryVector[] {
    const userVectorIds = this.userVectorIndex.get(userId);
    if (!userVectorIds) return [];

    return Array.from(userVectorIds)
      .map(id => this.vectors.get(id))
      .filter(Boolean) as MemoryVector[];
  }

  /**
   * 获取所有记忆（用于批量操作）
   */
  getAllMemories(): MemoryVector[] {
    return Array.from(this.vectors.values());
  }

  /**
   * 删除记忆
   */
  removeMemory(memoryId: string): boolean {
    const vector = this.vectors.get(memoryId);
    if (!vector) return false;

    this.vectors.delete(memoryId);
    
    // 从用户索引中移除
    const userVectors = this.userVectorIndex.get(vector.metadata.userId);
    if (userVectors) {
      userVectors.delete(memoryId);
      if (userVectors.size === 0) {
        this.userVectorIndex.delete(vector.metadata.userId);
      }
    }

    this.markDirty();

    metrics.increment("memory.vector.removed", 1, {
      type: vector.metadata.type,
      userId: vector.metadata.userId
    });

    // 同步从BM25索引中删除（异步执行，不阻塞）
    vectorBM25Index.removeMemory(memoryId).catch(err => {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to remove memory from BM25 index",
        cause: err instanceof Error ? err : undefined
      }));
    });

    return true;
  }

  /**
   * 更新记忆元数据
   */
  async updateMemory(
    memoryId: string,
    updates: {
      metadata?: Partial<MemoryVector['metadata']>;
      accessCount?: number;
      lastAccessed?: number;
    }
  ): Promise<boolean> {
    const vector = this.vectors.get(memoryId);
    if (!vector) return false;

    // 更新元数据
    if (updates.metadata) {
      vector.metadata = {
        ...vector.metadata,
        ...updates.metadata
      };
    }

    // 更新访问计数
    if (updates.accessCount !== undefined) {
      vector.accessCount = updates.accessCount;
    }

    // 更新最后访问时间
    if (updates.lastAccessed !== undefined) {
      vector.lastAccessed = updates.lastAccessed;
    }

    this.markDirty();

    metrics.increment("memory.vector.updated", 1, {
      type: vector.metadata.type,
      userId: vector.metadata.userId
    });

    // 同步更新BM25索引（如果类型改变，需要重新索引）
    if (updates.metadata?.type) {
      await vectorBM25Index.indexMemory(vector).catch(err => {
        logError(new JPClawError({
          code: ErrorCode.MEMORY_OPERATION_FAILED,
          message: "Failed to update memory in BM25 index",
          cause: err instanceof Error ? err : undefined
        }));
      });
    }

    log("debug", "Memory updated", {
      memoryId,
      type: vector.metadata.type,
      importance: vector.metadata.importance
    });

    return true;
  }

  /**
   * 清理过期记忆
   */
  async cleanupExpiredMemories(options: {
    maxAge?: number; // 毫秒
    maxVectorsPerUser?: number;
    minImportance?: number;
  } = {}): Promise<{ removed: number; kept: number }> {
    const maxAge = options.maxAge || MEMORY_CONSTANTS.VECTOR.DEFAULT_MAX_AGE_MS;
    const maxVectorsPerUser = options.maxVectorsPerUser || MEMORY_CONSTANTS.VECTOR.DEFAULT_MAX_VECTORS_PER_USER;
    const minImportance = options.minImportance || MEMORY_CONSTANTS.VECTOR.MIN_IMPORTANCE_THRESHOLD;
    const now = Date.now();
    
    let removed = 0;
    let kept = 0;

    // 按用户清理
    for (const [userId, vectorIds] of this.userVectorIndex) {
      const userVectors = Array.from(vectorIds)
        .map(id => this.vectors.get(id))
        .filter(Boolean) as MemoryVector[];

      // 按重要性和访问时间排序
      userVectors.sort((a, b) => {
        const aScore = a.metadata.importance * 0.5 + (a.lastAccessed / now) * 0.5;
        const bScore = b.metadata.importance * 0.5 + (b.lastAccessed / now) * 0.5;
        return bScore - aScore;
      });

      for (let i = 0; i < userVectors.length; i++) {
        const vector = userVectors[i];
        const age = now - vector.metadata.timestamp;
        
        const shouldRemove = 
          // 超过最大数量限制
          (i >= maxVectorsPerUser) ||
          // 过期且重要性低
          (age > maxAge && vector.metadata.importance < minImportance) ||
          // 长期未访问且重要性很低
          (now - vector.lastAccessed > maxAge * 2 && vector.metadata.importance < 0.2);

        if (shouldRemove && vector.metadata.type !== "pinned") {
          this.removeMemory(vector.id);
          removed++;
        } else {
          kept++;
        }
      }
    }

    this.markDirty();
    await this.saveVectors();

    log("info", "Memory cleanup completed", { removed, kept });

    return { removed, kept };
  }

  /**
   * 获取记忆统计
   */
  getStatistics(): {
    totalVectors: number;
    userCount: number;
    typeDistribution: Record<string, number>;
    averageImportance: number;
  } {
    const typeDistribution: Record<string, number> = {};
    let totalImportance = 0;

    for (const vector of this.vectors.values()) {
      const type = vector.metadata.type;
      typeDistribution[type] = (typeDistribution[type] || 0) + 1;
      totalImportance += vector.metadata.importance;
    }

    return {
      totalVectors: this.vectors.size,
      userCount: this.userVectorIndex.size,
      typeDistribution,
      averageImportance: this.vectors.size > 0 ? totalImportance / this.vectors.size : 0
    };
  }

  private filterCandidates(filters?: SemanticQuery["filters"]): MemoryVector[] {
    let candidates = Array.from(this.vectors.values());

    if (!filters) return candidates;

    if (filters.userId) {
      const userVectorIds = this.userVectorIndex.get(filters.userId);
      if (!userVectorIds) return [];
      candidates = candidates.filter(v => userVectorIds.has(v.id));
    }

    if (filters.type) {
      candidates = candidates.filter(v => v.metadata.type === filters.type);
    }

    if (filters.category) {
      candidates = candidates.filter(v => v.metadata.category === filters.category);
    }

    if (filters.tags && filters.tags.length > 0) {
      candidates = candidates.filter(v => 
        v.metadata.tags?.some(tag => filters.tags!.includes(tag))
      );
    }

    if (filters.minImportance !== undefined) {
      candidates = candidates.filter(v => v.metadata.importance >= filters.minImportance!);
    }

    if (filters.timeRange) {
      candidates = candidates.filter(v => 
        v.metadata.timestamp >= filters.timeRange!.from &&
        v.metadata.timestamp <= filters.timeRange!.to
      );
    }

    return candidates;
  }

  private calculateCompositeScore(vector: MemoryVector, similarity: number, query: string): number {
    const now = Date.now();
    
    // 相似度权重 (40%)
    const similarityScore = similarity * 0.4;
    
    // 重要性权重 (30%)
    const importanceScore = vector.metadata.importance * 0.3;
    
    // 时间衰减权重 (20%)
    const age = now - vector.metadata.timestamp;
    const timeDecay = calculateTimeDecay(age);
    const timeScore = timeDecay * 0.2;

    // 访问频率权重 (10%)
    const accessScore = Math.min(1, vector.accessCount / MEMORY_CONSTANTS.VECTOR.ACCESS_COUNT_NORMALIZATION_BASE) * 0.1;
    
    // 内容长度匹配加成
    const lengthBonus = this.calculateLengthBonus(vector.content, query);
    
    return similarityScore + importanceScore + timeScore + accessScore + lengthBonus;
  }

  private calculateLengthBonus(content: string, query: string): number {
    // 对于较短精确的内容给予加成
    const contentLength = content.length;
    const queryLength = query.length;
    
    if (contentLength < 100 && queryLength < 50) {
      return 0.05; // 短内容匹配加成
    }
    
    if (content.includes(query.trim()) && query.length > 3) {
      return 0.1; // 精确包含加成
    }
    
    return 0;
  }

  private async getEmbedding(text: string): Promise<number[]> {
    try {
      const result = await embeddingService.getEmbedding(text);
      return result.embedding;
    } catch (error) {
      log("error", "Failed to get embedding from service, using fallback", {
        error: error instanceof Error ? error.message : String(error)
      });

      // 如果embedding服务失败，回退到简单embedding
      return this.generateSimpleEmbedding(text);
    }
  }

  private generateSimpleEmbedding(text: string): number[] {
    // 简化的向量生成 - 仅作为fallback使用
    // 正常情况应该由embeddingService处理
    const dimensions = 384;
    const embedding = new Array(dimensions).fill(0);

    // 字符频率特征
    const chars = text.toLowerCase();
    for (let i = 0; i < chars.length && i < dimensions / 2; i++) {
      const charCode = chars.charCodeAt(i);
      embedding[i % dimensions] += Math.sin(charCode / 127) * 0.1;
    }

    // 词频特征
    const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    const wordSet = new Set(words);
    for (const word of wordSet) {
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = ((hash << 5) - hash + word.charCodeAt(i)) & 0xffffffff;
      }
      const index = Math.abs(hash) % dimensions;
      embedding[index] += 1 / Math.sqrt(wordSet.size);
    }

    // 归一化
    const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    if (norm > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= norm;
      }
    }

    return embedding;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);
    
    if (normA === 0 || normB === 0) return 0;
    
    return Math.max(0, Math.min(1, dotProduct / (normA * normB)));
  }

  private generateMemoryId(content: string, userId: string): string {
    const hash = createHash("sha256").update(userId + content).digest("hex");
    return `mem_${hash.slice(0, 16)}_${Date.now()}`;
  }

  private markDirty(): void {
    this.isDirty = true;

    // 定期保存
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveVectors();
    }, 10000); // 10秒后保存

    // 优化：允许进程优雅退出
    this.saveTimer.unref();
  }

  private loadVectors(): void {
    try {
      const vectorFile = path.join(this.vectorDirectory, "vectors.json");
      const indexFile = path.join(this.vectorDirectory, "index.json");
      
      if (fs.existsSync(vectorFile)) {
        const vectorData = JSON.parse(fs.readFileSync(vectorFile, 'utf-8'));
        for (const [id, vector] of Object.entries(vectorData)) {
          this.vectors.set(id, vector as MemoryVector);
        }
      }
      
      if (fs.existsSync(indexFile)) {
        const indexData = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
        for (const [userId, vectorIds] of Object.entries(indexData)) {
          this.userVectorIndex.set(userId, new Set(vectorIds as string[]));
        }
      }
      
      log("info", "Vector memory loaded", {
        vectorCount: this.vectors.size,
        userCount: this.userVectorIndex.size
      });
    } catch (error) {
      log("warn", "Failed to load vector memory", { error: String(error) });
    }
  }

  /**
   * 优化：使用互斥锁和原子写入防止数据损坏
   */
  /**
   * 立即保存向量数据（P0-10修复：优雅关闭时调用）
   *
   * 提供public接口用于优雅关闭时强制保存数据
   */
  async flush(): Promise<void> {
    if (!this.isDirty) return;
    await this.saveVectors();
  }

  /**
   * 优化：使用Promise队列确保串行执行，修复竞态条件
   *
   * 问题：之前在enqueue和doSave两处都检查isDirty，导致竞态条件
   * 解决：在enqueue时立即标记dirty=false，失败时恢复
   */
  private async saveVectors(): Promise<void> {
    if (!this.isDirty) return;

    // 立即标记为非dirty，防止重复enqueue（修复竞态条件）
    const shouldSave = this.isDirty;
    this.isDirty = false;

    if (!shouldSave) return;

    // 将保存操作加入队列，确保串行执行
    this.saveQueue = this.saveQueue
      .then(() => this.doSaveVectors())
      .catch(error => {
        // 保存失败时恢复dirty标记
        this.isDirty = true;
        logError(new JPClawError({
          code: ErrorCode.MEMORY_SAVE_FAILED,
          message: "Failed to save vector memory",
          cause: error instanceof Error ? error : undefined
        }));
      });

    await this.saveQueue;
  }

  /**
   * 实际执行保存操作（不再检查isDirty）
   */
  private async doSaveVectors(): Promise<void> {

    const vectorFile = path.join(this.vectorDirectory, "vectors.json");
    const indexFile = path.join(this.vectorDirectory, "index.json");
    const tempVectorFile = `${vectorFile}.tmp`;
    const tempIndexFile = `${indexFile}.tmp`;

    // 保存向量数据
    const vectorData: Record<string, MemoryVector> = {};
    for (const [id, vector] of this.vectors) {
      vectorData[id] = vector;
    }

    // 保存索引数据
    const indexData: Record<string, string[]> = {};
    for (const [userId, vectorIds] of this.userVectorIndex) {
      indexData[userId] = Array.from(vectorIds);
    }

    // 使用异步文件操作+临时文件+原子重命名
    await fs.promises.writeFile(tempVectorFile, JSON.stringify(vectorData, null, 2));
    await fs.promises.writeFile(tempIndexFile, JSON.stringify(indexData, null, 2));

    await fs.promises.rename(tempVectorFile, vectorFile);
    await fs.promises.rename(tempIndexFile, indexFile);

    this.isDirty = false;

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }

    log("debug", "Vector memory saved", {
      vectorCount: this.vectors.size,
      userCount: this.userVectorIndex.size
    });
  }

  // ========================================
  // 多模态记忆方法（一体化架构）
  // ========================================

  /**
   * 添加图片记忆
   *
   * @param imageBuffer 图片Buffer
   * @param userId 用户ID
   * @param options 配置选项
   * @returns 记忆ID
   */
  async addImageMemory(
    imageBuffer: Buffer,
    userId: string,
    options: {
      extractOCR?: boolean;
      importance?: number;
      memoryType?: MemoryVector["metadata"]["type"];
      originalPath?: string;
      mimeType?: string;
    } = {}
  ): Promise<string> {
    try {
      const startTime = Date.now();

      // 1. 生成图片embedding
      const imageEmbResult = await embeddingService.getImageEmbedding(imageBuffer);

      // 2. OCR提取（如果启用）
      let ocrText: string | undefined;
      let textEmbedding: number[] | undefined;

      if (options.extractOCR) {
        // TODO: 集成OCR服务（Tesseract等）
        // 暂时跳过，未来实现
        log("debug", "OCR extraction skipped (not implemented)");
      }

      // 3. 构建记忆对象
      const content = ocrText || '[Image]';
      const id = this.generateMemoryId(content, userId);

      const vector: MemoryVector = {
        id,
        content,
        embedding: textEmbedding || imageEmbResult.embedding,
        imageEmbedding: imageEmbResult.embedding,
        ocrText,
        metadata: {
          userId,
          type: options.memoryType || 'shortTerm',
          timestamp: Date.now(),
          importance: options.importance ?? 0.5,
          multimodalType: 'image',
          originalPath: options.originalPath,
          mimeType: options.mimeType || 'image/jpeg',
          size: imageBuffer.length
        },
        lastAccessed: Date.now(),
        accessCount: 1
      };

      // 4. 存储
      this.vectors.set(id, vector);

      const userVectorIds = this.userVectorIndex.get(userId) || new Set();
      userVectorIds.add(id);
      this.userVectorIndex.set(userId, userVectorIds);

      this.markDirty();

      const duration = Date.now() - startTime;

      log("info", "Image memory added", {
        id,
        userId,
        hasOCR: !!ocrText,
        imageEmbModel: imageEmbResult.model,
        duration
      });

      metrics.increment("memory.image.added", 1, { userId });
      metrics.timing("memory.image.add_duration", duration, {});

      return id;
    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to add image memory",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 以图搜图 - 查找视觉相似的记忆
   *
   * @param imageBuffer 查询图片
   * @param userId 用户ID
   * @param options 查询选项
   * @returns 搜索结果
   */
  async searchByImage(
    imageBuffer: Buffer,
    userId: string,
    options: {
      limit?: number;
      threshold?: number;
      includeTextMemories?: boolean;
    } = {}
  ): Promise<VectorSearchResult[]> {
    try {
      const startTime = Date.now();

      // 1. 生成查询图片的embedding
      const queryEmbResult = await embeddingService.getImageEmbedding(imageBuffer);

      // 2. 获取候选记忆
      const userVectorIds = this.userVectorIndex.get(userId);
      if (!userVectorIds || userVectorIds.size === 0) {
        return [];
      }

      let candidates = Array.from(this.vectors.values())
        .filter(v => userVectorIds.has(v.id) && v.imageEmbedding);

      if (candidates.length === 0) {
        log("debug", "No image memories found for user", { userId });
        return [];
      }

      // 3. 计算相似度
      const threshold = options.threshold ?? 0.7;
      const results = candidates.map(v => ({
        vector: v,
        similarity: this.cosineSimilarity(queryEmbResult.embedding, v.imageEmbedding!),
        rank: 0
      })).filter(r => r.similarity >= threshold);

      // 4. 排序并限制数量
      results.sort((a, b) => b.similarity - a.similarity);
      const limitedResults = results.slice(0, options.limit || 10);

      // 5. 分配排名并更新访问统计
      limitedResults.forEach((result, index) => {
        result.rank = index + 1;
        result.vector.lastAccessed = Date.now();
        result.vector.accessCount++;
      });

      if (limitedResults.length > 0) {
        this.markDirty();
      }

      const duration = Date.now() - startTime;

      log("debug", "Image search completed", {
        userId,
        candidatesCount: candidates.length,
        resultsCount: limitedResults.length,
        threshold,
        duration
      });

      metrics.increment("memory.image.search", 1, {
        resultsCount: limitedResults.length.toString()
      });

      return limitedResults;
    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_RETRIEVAL_FAILED,
        message: "Failed to search by image",
        cause: error instanceof Error ? error : undefined
      }));
      return [];
    }
  }

  /**
   * 添加音频记忆（降级为文本）
   *
   * @param audioPath 音频文件路径
   * @param userId 用户ID
   * @param options 配置选项
   * @returns 记忆ID
   */
  async addAudioMemory(
    audioPath: string,
    userId: string,
    options: {
      extractTranscript?: boolean;
      importance?: number;
      memoryType?: MemoryVector["metadata"]["type"];
    } = {}
  ): Promise<string> {
    try {
      // TODO: 集成音频转录服务（Whisper等）
      // 暂时返回占位符
      const transcript = "[Audio transcription not implemented]";

      const textEmbResult = await embeddingService.getEmbedding(transcript);

      const id = this.generateMemoryId(transcript, userId);
      const vector: MemoryVector = {
        id,
        content: transcript,
        embedding: textEmbResult.embedding,
        transcript,
        metadata: {
          userId,
          type: options.memoryType || 'shortTerm',
          timestamp: Date.now(),
          importance: options.importance ?? 0.5,
          multimodalType: 'audio',
          originalPath: audioPath
        },
        lastAccessed: Date.now(),
        accessCount: 1
      };

      this.vectors.set(id, vector);

      const userVectorIds = this.userVectorIndex.get(userId) || new Set();
      userVectorIds.add(id);
      this.userVectorIndex.set(userId, userVectorIds);

      this.markDirty();

      log("info", "Audio memory added (as text)", {
        id,
        userId,
        transcriptLength: transcript.length
      });

      return id;
    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to add audio memory",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 获取多模态统计信息
   */
  getMultimodalStatistics(userId?: string): {
    totalMemories: number;
    byType: Record<MultimodalType, number>;
    withImageEmbedding: number;
    withOCR: number;
    withTranscript: number;
  } {
    let memories = Array.from(this.vectors.values());

    if (userId) {
      const userVectorIds = this.userVectorIndex.get(userId);
      if (userVectorIds) {
        memories = memories.filter(v => userVectorIds.has(v.id));
      }
    }

    const byType: Record<string, number> = {
      text: 0,
      image: 0,
      audio: 0,
      video: 0,
      document: 0
    };

    let withImageEmbedding = 0;
    let withOCR = 0;
    let withTranscript = 0;

    for (const memory of memories) {
      const type = memory.metadata.multimodalType || 'text';
      byType[type]++;

      if (memory.imageEmbedding) withImageEmbedding++;
      if (memory.ocrText) withOCR++;
      if (memory.transcript) withTranscript++;
    }

    return {
      totalMemories: memories.length,
      byType: byType as Record<MultimodalType, number>,
      withImageEmbedding,
      withOCR,
      withTranscript
    };
  }
}

// 导出全局实例
export const vectorMemoryStore = VectorMemoryStore.getInstance();