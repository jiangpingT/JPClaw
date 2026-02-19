/**
 * 增强记忆管理器
 * 整合向量化检索、智能冲突解决和知识图谱
 */

import path from "node:path";
import { log, logError } from "../shared/logger.js";
import { JPClawError, ErrorCode } from "../shared/errors.js";
import { metrics } from "../monitoring/metrics.js";
import { vectorMemoryStore, type MemoryVector, type SemanticQuery, type VectorSearchResult } from "./vector-store.js";
import { vectorBM25Index, type VectorBM25Hit } from "./vector-bm25-index.js";
import { conflictResolver, type IntelligentConflict, type ConflictResolution } from "./conflict-resolver.js";
import { extractPinnedNotes, extractProfileFromText, mergeProfile } from "./extract.js";
import { knowledgeGraph, type GraphExtractionResult } from "./knowledge-graph.js";
import type { GraphEntity, GraphRelation, GraphPath } from "./knowledge-graph-types.js";
import { compressionPolicy } from "./compression-policy.js";
import { compressionEngine } from "./compression-engine.js";
import { tokenBudgetManager, type TokenAllocation } from "./token-budget-manager.js";
import { memoryLifecycleManager, type LifecycleEvaluationResult } from "./memory-lifecycle-manager.js";
import { TransactionLog } from "./transaction-log.js";
import { MEMORY_CONSTANTS } from "../shared/constants.js";

export interface EnhancedMemoryQuery {
  text: string;
  userId: string;
  options?: {
    useSemanticSearch?: boolean;
    useLegacyRetrieval?: boolean;
    useGraphQuery?: boolean;
    graphQueryType?: "entity" | "relation" | "path" | "subgraph";
    maxResults?: number;
    semanticThreshold?: number;
    includeConflicts?: boolean;
    timeRange?: { from: number; to: number };
    categories?: string[];
    memoryTypes?: ("shortTerm" | "midTerm" | "longTerm" | "pinned" | "profile")[];
  };
}

export interface EnhancedMemoryResult {
  memories: MemoryItem[];
  conflicts: IntelligentConflict[];
  graphResults?: {
    entities: GraphEntity[];
    relations: GraphRelation[];
    paths?: GraphPath[];
  };
  metadata: {
    totalFound: number;
    semanticResults: number;
    graphResults: number;
    conflictsDetected: number;
    queryTime: number;
  };
}

export interface MemoryItem {
  id: string;
  content: string;
  type: "vector" | "legacy";
  source: "shortTerm" | "midTerm" | "longTerm" | "pinned" | "profile";
  score: number;
  timestamp: number;
  importance?: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryUpdateResult {
  success: boolean;
  vectorsAdded: string[];
  conflictsDetected: IntelligentConflict[];
  conflictsResolved: ConflictResolution[];
  graphExtracted?: GraphExtractionResult;
  errors: string[];
}

/**
 * 优化：支持依赖注入（可选）
 * 接口定义vectorStore需要的方法，允许注入不同实现
 */
export interface IVectorStore {
  searchMemories(query: SemanticQuery): Promise<VectorSearchResult[]>;
  addMemory(
    content: string,
    metadata: MemoryVector["metadata"],
    importance?: number
  ): Promise<string>;
  removeMemory(vectorId: string): void;
  getAllMemories(): MemoryVector[];
  getUserMemories(userId: string): MemoryVector[];
  getMemoryById(memoryId: string): MemoryVector | undefined;
  cleanupExpiredMemories(options?: {
    maxAge?: number;
    maxVectorsPerUser?: number;
    minImportance?: number;
  }): Promise<{
    removed: number;
    kept: number;
  }>;
  getStatistics(): any;
}

export class EnhancedMemoryManager {
  private static instance: EnhancedMemoryManager;
  private static initializing = false;
  private memoryDirectory: string;

  // 优化：可选的依赖注入（向后兼容）
  private injectedVectorStore?: IVectorStore;
  private injectedConflictResolver?: typeof conflictResolver;
  private injectedBM25Index?: typeof vectorBM25Index;

  private constructor(dependencies?: {
    vectorStore?: IVectorStore;
    conflictResolver?: typeof conflictResolver;
    bm25Index?: typeof vectorBM25Index;
  }) {
    this.memoryDirectory = process.env.JPCLAW_MEMORY_DIR ||
      path.resolve(process.cwd(), "sessions", "memory");

    // 注入依赖（如果提供）
    if (dependencies) {
      this.injectedVectorStore = dependencies.vectorStore;
      this.injectedConflictResolver = dependencies.conflictResolver;
      this.injectedBM25Index = dependencies.bm25Index;
    }
  }

  /**
   * 获取vectorStore实例（优先使用注入的，否则使用全局实例）
   */
  private get vectorStore(): IVectorStore {
    return this.injectedVectorStore || vectorMemoryStore;
  }

  /**
   * 获取conflictResolver实例
   */
  private get resolver(): typeof conflictResolver {
    return this.injectedConflictResolver || conflictResolver;
  }

  /**
   * 获取BM25索引实例
   */
  private get bm25Index(): typeof vectorBM25Index {
    return this.injectedBM25Index || vectorBM25Index;
  }

  /**
   * 优化：防止竞态条件的单例实现，支持可选的依赖注入
   *
   * @param dependencies 可选的依赖注入（仅在首次调用时有效）
   */
  static getInstance(dependencies?: {
    vectorStore?: IVectorStore;
    conflictResolver?: typeof conflictResolver;
    bm25Index?: typeof vectorBM25Index;
  }): EnhancedMemoryManager {
    if (this.instance) {
      // 如果实例已存在，返回现有实例（忽略dependencies）
      if (dependencies) {
        log("warn", "EnhancedMemoryManager already initialized, dependencies ignored");
      }
      return this.instance;
    }

    if (this.initializing) {
      throw new Error("EnhancedMemoryManager is already being initialized. Please wait for initialization to complete.");
    }

    try {
      this.initializing = true;
      this.instance = new EnhancedMemoryManager(dependencies);
      return this.instance;
    } finally {
      this.initializing = false;
    }
  }

  /**
   * 增强记忆查询 - 结合语义检索和传统检索
   */
  async query(query: EnhancedMemoryQuery): Promise<EnhancedMemoryResult> {
    const startTime = Date.now();
    
    try {
      const options = {
        useSemanticSearch: true,
        useLegacyRetrieval: false,  // 旧系统已废弃
        useGraphQuery: false,
        maxResults: 10,
        semanticThreshold: 0.1,
        includeConflicts: false,
        ...query.options
      };

      const memories: MemoryItem[] = [];
      let semanticResults = 0;
      let conflicts: IntelligentConflict[] = [];
      let graphResults: { entities: GraphEntity[]; relations: GraphRelation[]; paths?: GraphPath[] } | undefined;
      let graphResultCount = 0;

      // 1. 混合检索（向量 + BM25）
      if (options.useSemanticSearch) {
        // 1.1 向量语义检索
        const semanticQuery: SemanticQuery = {
          text: query.text,
          filters: {
            userId: query.userId,
            timeRange: options.timeRange,
            type: options.memoryTypes?.[0] // 简化处理
          },
          limit: options.maxResults * 2, // 扩大候选集，用于混合排序
          threshold: options.semanticThreshold
        };

        const vectorResults = await this.vectorStore.searchMemories(semanticQuery);

        // 1.2 BM25关键词检索
        const bm25Results = await this.bm25Index.search(query.text, {
          userId: query.userId,
          type: options.memoryTypes,
          limit: options.maxResults * 2,
          minScore: 0
        });

        // 1.3 混合排序：使用常量定义的权重
        // VECTOR_WEIGHT * 向量相似度 + BM25_WEIGHT * BM25分数
        const hybridScores = new Map<string, { score: number; vector?: MemoryVector; bm25?: VectorBM25Hit }>();

        // 归一化向量分数（0-1范围）
        const maxVectorScore = vectorResults[0]?.similarity || 1;
        for (const result of vectorResults) {
          const normalizedScore = result.similarity / maxVectorScore;
          hybridScores.set(result.vector.id, {
            score: normalizedScore * MEMORY_CONSTANTS.HYBRID_SEARCH.VECTOR_WEIGHT,
            vector: result.vector
          });
        }

        // 归一化BM25分数（0-1范围）并合并
        const maxBM25Score = bm25Results[0]?.score || 1;
        for (const result of bm25Results) {
          const normalizedScore = maxBM25Score > 0 ? result.score / maxBM25Score : 0;
          const existing = hybridScores.get(result.memoryId);
          if (existing) {
            // 已有向量分数，加上BM25分数
            existing.score += normalizedScore * MEMORY_CONSTANTS.HYBRID_SEARCH.BM25_WEIGHT;
            existing.bm25 = result;
          } else {
            // 只有BM25分数（可能向量相似度太低被过滤）
            const vector = this.vectorStore.getMemoryById(result.memoryId);
            if (vector) {
              hybridScores.set(result.memoryId, {
                score: normalizedScore * MEMORY_CONSTANTS.HYBRID_SEARCH.BM25_WEIGHT,
                vector,
                bm25: result
              });
            }
          }
        }

        // 1.4 优化：应用类型权重和时间衰减，然后一次性排序
        const now = Date.now();
        const typeWeights = MEMORY_CONSTANTS.MEMORY_TYPE_WEIGHTS;

        const scoredHybrid = Array.from(hybridScores.entries()).map(([id, { score, vector }]) => {
          if (!vector) return null;

          // 应用记忆类型权重
          const typeWeight = typeWeights[vector.metadata.type] || 1.0;

          // 应用时间衰减（7天窗口）
          const timeDecay = Math.exp(-(now - vector.metadata.timestamp) / MEMORY_CONSTANTS.COMPRESSION.TIME_DECAY_WINDOW_MS);

          // 计算复合分数：基础分数 * 类型权重 * (基础权重 + 时间衰减权重 * 时间因子)
          const compositeScore = score * typeWeight * (MEMORY_CONSTANTS.COMPRESSION.BASE_SCORE_WEIGHT + MEMORY_CONSTANTS.COMPRESSION.TIME_DECAY_WEIGHT * timeDecay);

          return {
            id: vector.id,
            content: vector.content,
            type: "vector" as const,
            source: vector.metadata.type,
            score: compositeScore,
            timestamp: vector.metadata.timestamp,
            importance: vector.metadata.importance,
            metadata: vector.metadata
          };
        }).filter((item): item is NonNullable<typeof item> => item !== null);

        // 一次性排序并取前N个
        scoredHybrid.sort((a, b) => b.score - a.score);
        memories.push(...scoredHybrid.slice(0, options.maxResults));

        semanticResults = memories.length;

        log("debug", "Hybrid search completed", {
          userId: query.userId,
          query: query.text.slice(0, 50),
          vectorResults: vectorResults.length,
          bm25Results: bm25Results.length,
          hybridResults: memories.length
        });
      }

      // 2. 图谱查询
      if (options.useGraphQuery) {
        try {
          // 根据查询类型执行不同的图查询
          switch (options.graphQueryType) {
            case "entity":
              // 实体查询：按名称查找实体
              const entities = await knowledgeGraph.queryEntities({
                userId: query.userId,
                name: query.text,
                limit: options.maxResults
              });
              graphResults = { entities, relations: [] };
              graphResultCount = entities.length;
              break;

            case "subgraph":
              // 子图查询：提取子图
              // TODO: 需要先识别查询中的实体
              break;

            default:
              // 默认：查询所有相关实体（简化实现）
              const allEntities = await knowledgeGraph.queryEntities({
                userId: query.userId,
                limit: options.maxResults || 10
              });
              graphResults = { entities: allEntities, relations: [] };
              graphResultCount = allEntities.length;
          }

          log("debug", "Graph query completed", {
            userId: query.userId,
            queryType: options.graphQueryType || "default",
            resultCount: graphResultCount
          });
        } catch (error) {
          log("warn", "Graph query failed", {
            userId: query.userId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      // 4. 冲突检测
      if (options.includeConflicts) {
        conflicts = await this.detectMemoryConflicts(query.userId, memories);
      }

      // 5. 优化：混合搜索结果已经排序和应用了权重，直接截断即可
      // 如果没有使用semantic search，memories可能为空或未排序，需要排序
      let finalMemories: MemoryItem[];
      if (options.useSemanticSearch && memories.length > 0) {
        // 已排序，直接截断
        finalMemories = memories.slice(0, options.maxResults);
      } else {
        // 未使用semantic search或结果为空，使用传统排序
        const sortedMemories = this.rankAndMergeResults(memories, query.text);
        finalMemories = sortedMemories.slice(0, options.maxResults);
      }

      const result: EnhancedMemoryResult = {
        memories: finalMemories,
        conflicts,
        graphResults,
        metadata: {
          totalFound: memories.length,
          semanticResults,
          graphResults: graphResultCount,
          conflictsDetected: conflicts.length,
          queryTime: Date.now() - startTime
        }
      };

      log("debug", "Enhanced memory query completed", {
        userId: query.userId,
        query: query.text.slice(0, 50),
        totalResults: finalMemories.length,
        queryTime: result.metadata.queryTime
      });

      metrics.increment("memory.enhanced.query", 1, {
        userId: query.userId,
        resultsCount: finalMemories.length.toString()
      });

      return result;

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_RETRIEVAL_FAILED,
        message: "Enhanced memory query failed",
        cause: error instanceof Error ? error : undefined
      }));

      return {
        memories: [],
        conflicts: [],
        graphResults: undefined,
        metadata: {
          totalFound: 0,
          semanticResults: 0,
          graphResults: 0,
          conflictsDetected: 0,
          queryTime: Date.now() - startTime
        }
      };
    }
  }

  /**
   * 更新记忆 - 同时更新向量存储和传统存储
   */
  async updateMemory(
    userId: string,
    input: string,
    options: {
      userName?: string;
      category?: string;
      importance?: number;
      tags?: string[];
      autoResolveConflicts?: boolean;
      extractGraph?: boolean;
      useLLMForGraph?: boolean;
    } = {}
  ): Promise<MemoryUpdateResult> {
    const result: MemoryUpdateResult = {
      success: false,
      vectorsAdded: [],
      conflictsDetected: [],
      conflictsResolved: [],
      errors: []
    };

    // 优化：创建事务日志以支持原子性回滚
    const transaction = new TransactionLog(this.vectorStore);

    try {
      // 1. 提取结构化信息用于向量化存储
      const extractedInfo = this.extractStructuredInfo(input);

      // 3. 添加向量化记忆（记录到事务日志）
      const existingMemories = this.vectorStore.getUserMemories(userId);

      for (const info of extractedInfo) {
        try {
          const finalImportance = options.importance !== undefined ? options.importance : (info.importance || 0.5);
          const vectorId = await this.vectorStore.addMemory(
            info.content,
            {
              userId,
              type: info.type,
              timestamp: Date.now(),
              importance: finalImportance,
              category: options.category,
              tags: options.tags
            },
            finalImportance  // 第三个参数也要使用finalImportance
          );

          result.vectorsAdded.push(vectorId);
          // 记录添加操作到事务日志
          transaction.recordAdd(vectorId);
        } catch (error) {
          result.errors.push(`Failed to add vector memory: ${String(error)}`);
        }
      }

      // 4. 冲突检测
      if (result.vectorsAdded.length > 0) {
        for (const vectorId of result.vectorsAdded) {
          const newVector = this.vectorStore.getUserMemories(userId)
            .find(v => v.id === vectorId);
          
          if (newVector) {
            const conflicts = await this.resolver.detectConflicts(newVector, existingMemories);
            result.conflictsDetected.push(...conflicts);
          }
        }
      }

      // 5. 自动解决冲突（阶段1.4：事务化保护）
      // P1-NEW-8修复: 使用检查点实现冲突解决的原子性回滚
      if (options.autoResolveConflicts && result.conflictsDetected.length > 0) {
        // 创建检查点，冲突解决失败时只回滚冲突部分，保留向量添加
        transaction.createCheckpoint("before_conflict_resolution");

        try {
          for (const conflict of result.conflictsDetected) {
            if (conflict.autoResolvable) {
              const resolution = await this.resolver.resolveConflict(conflict.id);
              if (resolution) {
                result.conflictsResolved.push(resolution);
              } else {
                // 冲突解决失败，需要回滚
                throw new Error(`Failed to resolve conflict ${conflict.id}`);
              }
            }
          }
        } catch (resolveError) {
          // 优化：使用事务日志进行原子性回滚
          log("error", "memory.conflict_resolution_failed.rolling_back", {
            userId,
            operationCount: transaction.getOperationCount(),
            conflictsResolved: result.conflictsResolved.length,
            error: String(resolveError)
          });

          // P1-NEW-8修复: 尝试回滚到检查点（保留向量添加），失败则全量回滚
          try {
            await transaction.rollback("before_conflict_resolution");
            log("info", "memory.rollback.to_checkpoint", {
              checkpoint: "before_conflict_resolution",
              conflictsRolledBack: result.conflictsResolved.length,
              vectorsPreserved: result.vectorsAdded.length
            });

            // 只清空冲突解决结果，保留向量添加
            result.conflictsResolved = [];
            result.errors.push(`Conflict resolution failed, rolled back conflicts only: ${String(resolveError)}`);
            // 不设 success=false，因为向量添加仍然成功
          } catch (rollbackError) {
            // 检查点回滚失败，尝试全量回滚
            log("error", "memory.rollback.checkpoint_failed.trying_full", {
              error: String(rollbackError)
            });

            try {
              await transaction.rollback();
            } catch (fullRollbackError) {
              logError(new JPClawError({
                code: ErrorCode.MEMORY_OPERATION_FAILED,
                message: "Transaction rollback failed - data may be inconsistent",
                cause: fullRollbackError instanceof Error ? fullRollbackError : undefined,
                context: { userId, vectorsAdded: result.vectorsAdded }
              }));
              result.errors.push(`CRITICAL: Rollback failed - data may be inconsistent: ${String(fullRollbackError)}`);
            }

            result.vectorsAdded = [];
            result.conflictsResolved = [];
            result.errors.push(`Conflict resolution failed, full rollback: ${String(resolveError)}`);
            result.success = false;
            return result;
          }
        }
      }

      // 6. 知识图谱提取（新增）
      if (options.extractGraph !== false) {  // 默认开启
        try {
          // 使用第一个添加的向量ID作为memoryId
          const memoryId = result.vectorsAdded[0] || `mem_${Date.now()}`;

          const graphResult = await knowledgeGraph.extractFromMemory(
            input,
            userId,
            memoryId,
            {
              useLLM: options.useLLMForGraph || false,
              autoMerge: true,
              entityThreshold: 0.5,
              relationThreshold: 0.5
            }
          );

          result.graphExtracted = graphResult;

          log("debug", "Graph extraction completed", {
            userId,
            memoryId,
            entityCount: graphResult.entities.length,
            relationCount: graphResult.relations.length
          });
        } catch (error) {
          log("warn", "Graph extraction failed", {
            userId,
            error: error instanceof Error ? error.message : String(error)
          });
          result.errors.push(`Graph extraction failed: ${error}`);
        }
      }

      result.success = result.vectorsAdded.length > 0;

      // 优化：成功时提交事务（清空日志）
      if (result.success) {
        transaction.commit();
      }

      log("info", "Memory updated", {
        userId,
        vectorsAdded: result.vectorsAdded.length,
        conflictsDetected: result.conflictsDetected.length,
        conflictsResolved: result.conflictsResolved.length
      });

      metrics.increment("memory.enhanced.update", 1, {
        userId,
        vectorsAdded: result.vectorsAdded.length.toString(),
        conflictsDetected: result.conflictsDetected.length.toString()
      });

      return result;

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_SAVE_FAILED,
        message: "Failed to update enhanced memory",
        cause: error instanceof Error ? error : undefined
      }));

      result.errors.push(error instanceof Error ? error.message : String(error));
      return result;
    }
  }

  /**
   * 获取记忆统计信息
   */
  async getMemoryStats(userId: string): Promise<{
    vector: {
      totalVectors: number;
      byType: Record<string, number>;
      averageImportance: number;
      recentActivity: number;
    };
    conflicts: {
      total: number;
      autoResolvable: number;
      byType: Record<string, number>;
      bySeverity: Record<string, number>;
    };
  }> {
    // 向量记忆统计
    const userVectors = this.vectorStore.getUserMemories(userId);
    const vectorStats = this.vectorStore.getStatistics();
    const recentActivity = userVectors.filter(v =>
      Date.now() - v.lastAccessed < 7 * 24 * 60 * 60 * 1000
    ).length;

    const byType: Record<string, number> = {};
    let totalImportance = 0;
    for (const vector of userVectors) {
      byType[vector.metadata.type] = (byType[vector.metadata.type] || 0) + 1;
      totalImportance += vector.metadata.importance;
    }

    const vector = {
      totalVectors: userVectors.length,
      byType,
      averageImportance: userVectors.length > 0 ? totalImportance / userVectors.length : 0,
      recentActivity
    };

    // 冲突统计
    const conflicts = this.resolver.getConflictSummary(userId);

    return { vector, conflicts };
  }

  /**
   * 清理记忆
   */
  async cleanupMemory(
    userId: string,
    options: {
      maxVectorAge?: number;
      maxVectorsPerUser?: number;
      minImportance?: number;
      autoResolveConflicts?: boolean;
    } = {}
  ): Promise<{
    vectorsRemoved: number;
    conflictsResolved: number;
    errors: string[];
  }> {
    const result: {
      vectorsRemoved: number;
      conflictsResolved: number;
      errors: string[];
    } = {
      vectorsRemoved: 0,
      conflictsResolved: 0,
      errors: []
    };

    try {
      // 清理向量记忆
      const vectorCleanup = await this.vectorStore.cleanupExpiredMemories({
        maxAge: options.maxVectorAge,
        maxVectorsPerUser: options.maxVectorsPerUser,
        minImportance: options.minImportance
      });
      
      result.vectorsRemoved = vectorCleanup.removed;

      // 自动解决冲突
      if (options.autoResolveConflicts) {
        const resolutions = await this.resolver.resolveAllAutoConflicts(userId);
        result.conflictsResolved = resolutions.length;
      }

      log("info", "Memory cleanup completed", {
        userId,
        vectorsRemoved: result.vectorsRemoved,
        conflictsResolved: result.conflictsResolved
      });

      return result;

    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
      return result;
    }
  }

  private rankAndMergeResults(memories: MemoryItem[], query: string): MemoryItem[] {
    // 混合排序：语义分数 + 时间新鲜度 + 记忆类型权重
    const typeWeights = MEMORY_CONSTANTS.MEMORY_TYPE_WEIGHTS;

    return memories
      .map(memory => {
        const typeWeight = typeWeights[memory.source] || 1.0;
        const timeDecay = Math.exp(-(Date.now() - memory.timestamp) / (7 * 24 * 60 * 60 * 1000));
        const compositeScore = memory.score * typeWeight * (0.7 + 0.3 * timeDecay);
        
        return { ...memory, score: compositeScore };
      })
      .sort((a, b) => b.score - a.score);
  }

  private extractStructuredInfo(input: string): Array<{
    content: string;
    type: "shortTerm" | "midTerm" | "longTerm" | "pinned" | "profile";
    importance: number;
  }> {
    const extracted: Array<{
      content: string;
      type: "shortTerm" | "midTerm" | "longTerm" | "pinned" | "profile";
      importance: number;
    }> = [];

    // 提取 pinned notes
    const pinnedNotes = extractPinnedNotes(input);
    for (const note of pinnedNotes) {
      extracted.push({
        content: note,
        type: "pinned",
        importance: 0.9 // 高重要性
      });
    }

    // 提取 profile 信息
    const profileInfo = extractProfileFromText(input);
    if (Object.keys(profileInfo).length > 0) {
      for (const [key, value] of Object.entries(profileInfo)) {
        if (value && typeof value === "string") {
          extracted.push({
            content: `${key}: ${value}`,
            type: "profile",
            importance: 0.8
          });
        }
      }
    }

    // 分析句子重要性
    const sentences = input.split(/[.!?。！？]/).filter(s => s.trim().length > 5);
    for (const sentence of sentences) {
      const importance = this.calculateSentenceImportance(sentence);
      const type = this.classifySentenceType(sentence, importance);
      
      if (importance > 0.3) { // 过滤低重要性句子
        extracted.push({
          content: sentence.trim(),
          type,
          importance
        });
      }
    }

    // 如果没有提取到任何结构化信息，将整个输入作为短期记忆
    if (extracted.length === 0) {
      extracted.push({
        content: input.trim(),
        type: "shortTerm",
        importance: 0.5
      });
    }

    return extracted;
  }

  private calculateSentenceImportance(sentence: string): number {
    let importance = 0.5; // 基础重要性

    // 长度因子 - 太短或太长的句子重要性降低
    const length = sentence.length;
    if (length < 10) importance -= 0.2;
    else if (length > 200) importance -= 0.1;
    else if (length >= 20 && length <= 100) importance += 0.1;

    // 关键词检测
    const importantKeywords = [
      "重要", "关键", "必须", "一定", "绝对", "核心", "主要",
      "喜欢", "不喜欢", "偏好", "习惯", "经常", "总是", "从不"
    ];

    const factualKeywords = ["是", "为", "有", "在", "做", "会", "能"];

    for (const keyword of importantKeywords) {
      if (sentence.includes(keyword)) importance += 0.2;
    }

    for (const keyword of factualKeywords) {
      if (sentence.includes(keyword)) importance += 0.1;
    }

    // 时间表达式增加重要性
    const timePatterns = [
      /\d{4}[年\-\/]\d{1,2}[月\-\/]\d{1,2}/,
      /(今天|昨天|明天|上周|下周|去年|明年)/,
      /(现在|当前|目前|以后|之前|将来)/
    ];

    for (const pattern of timePatterns) {
      if (pattern.test(sentence)) {
        importance += 0.15;
        break;
      }
    }

    return Math.max(0, Math.min(1, importance));
  }

  private classifySentenceType(
    sentence: string,
    importance: number
  ): "shortTerm" | "midTerm" | "longTerm" | "pinned" | "profile" {
    // 已经被 extractPinnedNotes 处理的不会到这里
    
    // Profile 相关
    const profileKeywords = [
      "我是", "我叫", "我的名字", "我来自", "我住在", "我工作在",
      "我的爱好", "我喜欢", "我的技能", "我擅长"
    ];
    
    for (const keyword of profileKeywords) {
      if (sentence.includes(keyword)) return "profile";
    }

    // 长期记忆 - 重要且具有持久性的信息
    if (importance > 0.7) {
      const longTermIndicators = [
        "总是", "从来", "永远", "一直", "习惯", "经常",
        "原则", "信念", "价值观", "目标", "梦想"
      ];
      
      for (const indicator of longTermIndicators) {
        if (sentence.includes(indicator)) return "longTerm";
      }
    }

    // 中期记忆 - 中等重要性或有一定时效性
    if (importance > 0.5) {
      const midTermIndicators = [
        "计划", "打算", "准备", "学习", "项目", "工作",
        "最近", "这段时间", "这个月", "这周"
      ];
      
      for (const indicator of midTermIndicators) {
        if (sentence.includes(indicator)) return "midTerm";
      }
    }

    // 默认为短期记忆
    return "shortTerm";
  }

  private async detectMemoryConflicts(
    userId: string,
    memories: MemoryItem[]
  ): Promise<IntelligentConflict[]> {
    const conflicts: IntelligentConflict[] = [];

    // 将 MemoryItem 转换为 MemoryVector 格式以便冲突检测
    const pseudoVectors: MemoryVector[] = memories
      .filter(m => m.type === "vector")
      .map(m => ({
        id: m.id,
        content: m.content,
        embedding: [], // 空数组，冲突检测主要基于内容
        metadata: {
          userId,
          type: m.source,
          timestamp: m.timestamp,
          importance: m.importance || 0.5,
          category: m.metadata?.category,
          tags: m.metadata?.tags
        },
        lastAccessed: Date.now(),
        accessCount: 1
      })) as MemoryVector[];

    // 优化：使用向量相似度预过滤，避免O(n²)全量比较
    // 对于每个memory，只与最相关的K个比较（K默认为10）
    const MAX_CANDIDATES_PER_MEMORY = 10;

    for (let i = 0; i < pseudoVectors.length; i++) {
      const current = pseudoVectors[i];

      // 如果有embedding，使用向量相似度筛选候选
      if (current.embedding && current.embedding.length > 0) {
        // 计算与其他所有记忆的相似度
        const similarities = pseudoVectors
          .map((other, idx) => {
            if (idx <= i || !other.embedding || other.embedding.length === 0) {
              return { idx, similarity: -1 };
            }

            // 计算余弦相似度
            let dotProduct = 0;
            let normA = 0;
            let normB = 0;
            for (let k = 0; k < current.embedding.length; k++) {
              dotProduct += current.embedding[k] * other.embedding[k];
              normA += current.embedding[k] * current.embedding[k];
              normB += other.embedding[k] * other.embedding[k];
            }
            const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));

            return { idx, similarity };
          })
          .filter(s => s.similarity > 0)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, MAX_CANDIDATES_PER_MEMORY);

        // 只与最相似的K个比较
        for (const { idx } of similarities) {
          const conflicts1 = await this.resolver.detectConflicts(
            current,
            [pseudoVectors[idx]]
          );
          conflicts.push(...conflicts1);
        }
      } else {
        // 没有embedding的情况，只比较后续的前K个（避免全量比较）
        const candidateCount = Math.min(MAX_CANDIDATES_PER_MEMORY, pseudoVectors.length - i - 1);
        for (let j = i + 1; j < i + 1 + candidateCount; j++) {
          const conflicts1 = await this.resolver.detectConflicts(
            current,
            [pseudoVectors[j]]
          );
          conflicts.push(...conflicts1);
        }
      }
    }

    log("debug", "Conflict detection completed", {
      userId,
      memoriesChecked: pseudoVectors.length,
      conflictsFound: conflicts.length
    });

    return conflicts;
  }

  /**
   * 智能提炼记忆用于上下文注入
   * 根据Token预算智能选择和格式化记忆
   */
  async distillMemoriesForContext(
    userId: string,
    currentQuery: string,
    maxTokens: number = 8000
  ): Promise<{
    distilled: string;
    sources: MemoryItem[];
    tokensUsed: number;
  }> {
    try {
      // 1. 检索相关记忆
      const relevant = await this.query({
        text: currentQuery,
        userId,
        options: {
          useSemanticSearch: true,
          useLegacyRetrieval: true,
          useGraphQuery: true,
          maxResults: 50
        }
      });

      // 2. 获取Token预算分配
      const allocation = tokenBudgetManager.allocateBudget(userId);

      // 3. 按类型分组
      const byType: Record<string, MemoryItem[]> = {
        pinned: [],
        profile: [],
        longTerm: [],
        midTerm: [],
        shortTerm: []
      };

      for (const memory of relevant.memories) {
        const type = memory.source || 'shortTerm';
        if (byType[type]) {
          byType[type].push(memory);
        }
      }

      // 4. 按预算选择记忆
      const selected: MemoryItem[] = [];
      let usedTokens = 0;

      const priorityOrder = ['pinned', 'profile', 'longTerm', 'midTerm', 'shortTerm'] as const;

      for (const type of priorityOrder) {
        const candidates = byType[type];
        if (candidates.length === 0) continue;

        const typeBudget = allocation[type] || 0;
        const availableTokens = Math.min(typeBudget, maxTokens - usedTokens);

        // 转换为MemoryVector格式以使用tokenBudgetManager
        const vectorCandidates: MemoryVector[] = candidates.map(m => ({
          id: m.id,
          content: m.content,
          embedding: [],
          metadata: {
            userId,
            type: type as any,
            timestamp: m.timestamp,
            importance: m.importance || 0.5
          },
          lastAccessed: Date.now(),
          accessCount: 1
        }));

        const typeSelected = tokenBudgetManager.selectMemoriesWithinBudget(
          vectorCandidates,
          availableTokens,
          'relevance'
        );

        // 转换回MemoryItem
        const selectedItems = typeSelected.map(v =>
          candidates.find(c => c.id === v.id)!
        );

        selected.push(...selectedItems);
        usedTokens += typeSelected.reduce((sum, v) =>
          sum + tokenBudgetManager.estimateTokens(v.content), 0
        );

        if (usedTokens >= maxTokens) break;
      }

      // 5. 格式化输出
      const distilled = this.formatDistilledMemories(selected);

      log("info", "Memories distilled for context", {
        userId,
        totalMemories: relevant.memories.length,
        selectedMemories: selected.length,
        tokensUsed: usedTokens,
        maxTokens
      });

      return {
        distilled,
        sources: selected,
        tokensUsed: usedTokens
      };

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to distill memories for context",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 自动压缩记忆
   * 检测触发条件并执行压缩策略
   */
  async autoCompressMemories(userId: string): Promise<{
    compressed: boolean;
    tokensSaved: number;
    errors: string[];
  }> {
    try {
      // 1. 获取用户所有记忆
      const allMemories = await this.vectorStore.getUserMemories(userId);

      // 2. 检查是否需要压缩
      const triggers = compressionPolicy.shouldCompress(userId, allMemories);

      if (triggers.length === 0) {
        log("debug", "No compression needed", { userId });
        return { compressed: false, tokensSaved: 0, errors: [] };
      }

      // 3. 执行压缩
      const result = await compressionEngine.compressMemories(userId, allMemories, triggers);

      log("info", "Auto compression completed", {
        userId,
        triggers: triggers.map(t => t.type),
        executed: result.executed,
        deleted: result.deleted,
        created: result.created,
        tokensSaved: result.tokensSaved,
        errors: result.errors.length
      });

      return {
        compressed: result.executed > 0,
        tokensSaved: result.tokensSaved,
        errors: result.errors
      };

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to auto compress memories",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 评估用户记忆的生命周期（升级/降级/淘汰）
   */
  async evaluateMemoryLifecycle(userId: string): Promise<LifecycleEvaluationResult> {
    try {
      log("info", "Starting memory lifecycle evaluation", { userId });

      const result = await memoryLifecycleManager.evaluateUser(userId);

      log("info", "Memory lifecycle evaluation completed", {
        userId,
        upgraded: result.upgraded,
        downgraded: result.downgraded,
        deleted: result.deleted,
        unchanged: result.unchanged
      });

      return result;
    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to evaluate memory lifecycle",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 启动定期的记忆生命周期评估
   */
  startLifecycleEvaluation(): void {
    log("info", "Starting scheduled memory lifecycle evaluation");
    memoryLifecycleManager.startScheduledEvaluation();
  }

  /**
   * 停止定期的记忆生命周期评估
   */
  stopLifecycleEvaluation(): void {
    log("info", "Stopping scheduled memory lifecycle evaluation");
    memoryLifecycleManager.stopScheduledEvaluation();
  }

  /**
   * 获取记忆生命周期统计信息
   */
  getLifecycleStats(userId: string): {
    totalCount: number;
    byType: Record<string, number>;
    averageImportance: Record<string, number>;
    averageAccessCount: Record<string, number>;
    averageAge: Record<string, number>;
  } {
    return memoryLifecycleManager.getMemoryStats(userId);
  }

  /**
   * 格式化提炼的记忆
   */
  private formatDistilledMemories(memories: MemoryItem[]): string {
    const byType: Record<string, MemoryItem[]> = {};

    for (const memory of memories) {
      const type = memory.source || 'shortTerm';
      if (!byType[type]) byType[type] = [];
      byType[type].push(memory);
    }

    const sections: string[] = [];

    if (byType.pinned?.length > 0) {
      sections.push('【重要提示】\n' + byType.pinned.map(m => `- ${m.content}`).join('\n'));
    }
    if (byType.profile?.length > 0) {
      sections.push('【用户信息】\n' + byType.profile.map(m => m.content).join('\n'));
    }
    if (byType.longTerm?.length > 0) {
      sections.push('【长期记忆】\n' + byType.longTerm.map(m => `- ${m.content}`).join('\n'));
    }
    if (byType.midTerm?.length > 0) {
      sections.push('【中期记忆】\n' + byType.midTerm.map(m => `- ${m.content}`).join('\n'));
    }
    if (byType.shortTerm?.length > 0) {
      sections.push('【短期记忆】\n' + byType.shortTerm.map(m => `- ${m.content}`).join('\n'));
    }

    return sections.join('\n\n');
  }
}

// 导出全局实例
export const enhancedMemoryManager = EnhancedMemoryManager.getInstance();