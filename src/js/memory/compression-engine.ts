/**
 * 智能压缩执行引擎
 * 实现4种压缩策略：Summarize、Update、Merge、Ignore
 */

import { log, logError } from "../shared/logger.js";
import { JPClawError, ErrorCode } from "../shared/errors.js";
import { vectorMemoryStore } from "./vector-store.js";
import type { MemoryVector } from "./vector-store.js";
import type { CompressionTrigger } from "./compression-policy.js";

/**
 * 压缩策略类型
 */
export type CompressionStrategy = 'summarize' | 'update' | 'merge' | 'ignore';

/**
 * 压缩决策
 */
export interface CompressionDecision {
  /** 策略类型 */
  strategy: CompressionStrategy;

  /** 目标记忆 */
  targetMemories: MemoryVector[];

  /** 置信度 (0-1) */
  confidence: number;

  /** 原因说明 */
  reason: string;
}

/**
 * 压缩结果
 */
export interface CompressionResult {
  /** 执行的策略数 */
  executed: number;

  /** 删除的记忆数 */
  deleted: number;

  /** 新创建的记忆数 */
  created: number;

  /** 节省的Token数 */
  tokensSaved: number;

  /** 错误列表 */
  errors: string[];

  /** 详细结果 */
  details: Array<{
    strategy: CompressionStrategy;
    targetIds: string[];
    success: boolean;
    error?: string;
  }>;
}

/**
 * 压缩引擎类
 */
export class CompressionEngine {
  /**
   * 执行记忆压缩
   */
  async compressMemories(
    userId: string,
    memories: MemoryVector[],
    triggers: CompressionTrigger[]
  ): Promise<CompressionResult> {
    const startTime = Date.now();

    const result: CompressionResult = {
      executed: 0,
      deleted: 0,
      created: 0,
      tokensSaved: 0,
      errors: [],
      details: []
    };

    try {
      log("info", "Starting memory compression", {
        userId,
        memoryCount: memories.length,
        triggers: triggers.map(t => t.type)
      });

      // 生成压缩决策
      const decisions = await this.generateCompressionDecisions(memories, triggers);

      log("debug", "Compression decisions generated", {
        decisionCount: decisions.length
      });

      // 执行每个决策
      for (const decision of decisions) {
        try {
          const strategyResult = await this.executeStrategy(
            userId,
            decision.strategy,
            decision.targetMemories
          );

          result.executed++;
          result.deleted += strategyResult.deleted;
          result.created += strategyResult.created;
          result.tokensSaved += strategyResult.tokensSaved;

          result.details.push({
            strategy: decision.strategy,
            targetIds: decision.targetMemories.map(m => m.id),
            success: true
          });

        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          result.errors.push(errorMsg);

          result.details.push({
            strategy: decision.strategy,
            targetIds: decision.targetMemories.map(m => m.id),
            success: false,
            error: errorMsg
          });

          logError(new JPClawError({
            code: ErrorCode.MEMORY_OPERATION_FAILED,
            message: `Compression strategy ${decision.strategy} failed`,
            cause: error instanceof Error ? error : undefined
          }));
        }
      }

      const duration = Date.now() - startTime;

      log("info", "Memory compression completed", {
        userId,
        executed: result.executed,
        deleted: result.deleted,
        created: result.created,
        tokensSaved: result.tokensSaved,
        errors: result.errors.length,
        duration
      });

      return result;

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Memory compression failed",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 生成压缩决策
   */
  private async generateCompressionDecisions(
    memories: MemoryVector[],
    triggers: CompressionTrigger[]
  ): Promise<CompressionDecision[]> {
    const decisions: CompressionDecision[] = [];

    // 按规则生成决策（简化实现，不调用LLM）
    const groups = this.groupMemoriesForCompression(memories);

    for (const group of groups) {
      const decision = this.decideStrategy(group, triggers);
      if (decision) {
        decisions.push(decision);
      }
    }

    return decisions;
  }

  /**
   * 对记忆分组（用于压缩）
   */
  private groupMemoriesForCompression(memories: MemoryVector[]): MemoryVector[][] {
    const groups: MemoryVector[][] = [];

    // 策略1：按相似度分组（用于Merge）
    const similarGroups = this.groupBySimilarity(memories);
    groups.push(...similarGroups);

    // 策略2：低价值老旧记忆（用于Ignore）
    const lowValueMemories = this.findLowValueMemories(memories);
    if (lowValueMemories.length > 0) {
      groups.push(lowValueMemories);
    }

    // 策略3：时间连续的记忆（用于Summarize）
    const temporalGroups = this.groupByTemporalRelation(memories);
    groups.push(...temporalGroups);

    return groups;
  }

  /**
   * 按相似度分组
   */
  private groupBySimilarity(memories: MemoryVector[]): MemoryVector[][] {
    const groups: MemoryVector[][] = [];
    const visited = new Set<string>();

    for (const memory of memories) {
      if (visited.has(memory.id) || !memory.embedding) continue;

      const similar: MemoryVector[] = [memory];
      visited.add(memory.id);

      for (const other of memories) {
        if (visited.has(other.id) || !other.embedding) continue;

        const similarity = this.cosineSimilarity(memory.embedding, other.embedding);

        if (similarity > 0.85) {
          similar.push(other);
          visited.add(other.id);
        }
      }

      // 只保留有多个记忆的组
      if (similar.length > 1) {
        groups.push(similar);
      }
    }

    return groups;
  }

  /**
   * 查找低价值记忆
   */
  private findLowValueMemories(memories: MemoryVector[]): MemoryVector[] {
    const now = Date.now();
    const sixtyDaysAgo = now - 60 * 24 * 60 * 60 * 1000;

    return memories.filter(m => {
      const isOld = m.metadata.timestamp < sixtyDaysAgo;
      const isLowImportance = m.metadata.importance < 0.3;
      const isUnused = (m.accessCount || 0) <= 1;

      return isOld && isLowImportance && isUnused;
    });
  }

  /**
   * 按时间关系分组
   */
  private groupByTemporalRelation(memories: MemoryVector[]): MemoryVector[][] {
    const groups: MemoryVector[][] = [];
    const sorted = [...memories].sort((a, b) => a.metadata.timestamp - b.metadata.timestamp);

    let currentGroup: MemoryVector[] = [];
    const oneHour = 60 * 60 * 1000;

    for (const memory of sorted) {
      if (currentGroup.length === 0) {
        currentGroup.push(memory);
      } else {
        const lastMemory = currentGroup[currentGroup.length - 1];
        const timeDiff = memory.metadata.timestamp - lastMemory.metadata.timestamp;

        if (timeDiff <= oneHour) {
          currentGroup.push(memory);
        } else {
          if (currentGroup.length >= 5) {
            groups.push(currentGroup);
          }
          currentGroup = [memory];
        }
      }
    }

    if (currentGroup.length >= 5) {
      groups.push(currentGroup);
    }

    return groups;
  }

  /**
   * 决定压缩策略
   */
  private decideStrategy(
    memories: MemoryVector[],
    triggers: CompressionTrigger[]
  ): CompressionDecision | null {
    // 规则1：高度相似 → Merge
    if (memories.length > 1 && memories.length <= 5) {
      const avgSimilarity = this.calculateGroupSimilarity(memories);
      if (avgSimilarity > 0.85) {
        return {
          strategy: 'merge',
          targetMemories: memories,
          confidence: avgSimilarity,
          reason: `High similarity (${avgSimilarity.toFixed(2)}) between ${memories.length} memories`
        };
      }
    }

    // 规则2：低价值+老旧+未访问 → Ignore
    const allLowValue = memories.every(m => {
      const isOld = Date.now() - m.metadata.timestamp > 60 * 24 * 60 * 60 * 1000;
      const isLowImportance = m.metadata.importance < 0.3;
      const isUnused = (m.accessCount || 0) <= 1;
      return isOld && isLowImportance && isUnused;
    });

    if (allLowValue && memories.length > 0) {
      return {
        strategy: 'ignore',
        targetMemories: memories,
        confidence: 0.9,
        reason: `${memories.length} low-value, old, and unused memories`
      };
    }

    // 规则3：连续相关记忆 → Summarize
    if (memories.length >= 5 && this.areTemporallyRelated(memories)) {
      return {
        strategy: 'summarize',
        targetMemories: memories,
        confidence: 0.7,
        reason: `${memories.length} temporally related memories`
      };
    }

    return null;
  }

  /**
   * 执行压缩策略
   */
  private async executeStrategy(
    userId: string,
    strategy: CompressionStrategy,
    memories: MemoryVector[]
  ): Promise<{
    deleted: number;
    created: number;
    tokensSaved: number;
  }> {
    switch (strategy) {
      case 'summarize':
        return await this.executeSummarize(userId, memories);
      case 'update':
        return await this.executeUpdate(userId, memories);
      case 'merge':
        return await this.executeMerge(userId, memories);
      case 'ignore':
        return await this.executeIgnore(userId, memories);
      default:
        throw new Error(`Unknown compression strategy: ${strategy}`);
    }
  }

  /**
   * 执行Summarize策略（总结）
   */
  private async executeSummarize(
    userId: string,
    memories: MemoryVector[]
  ): Promise<{ deleted: number; created: number; tokensSaved: number }> {
    log("debug", "Executing summarize strategy", {
      userId,
      memoryCount: memories.length
    });

    // 简化实现：直接合并内容（不调用LLM）
    const combinedContent = memories.map((m, i) => `${i + 1}. ${m.content}`).join('\n');
    const summaryContent = `[Summary of ${memories.length} memories]\n${combinedContent.slice(0, 500)}...`;

    const originalTokens = this.estimateTokens(combinedContent);
    const summaryTokens = this.estimateTokens(summaryContent);

    // ✅ 实际执行：创建摘要记忆
    const importance = Math.max(...memories.map(m => m.metadata.importance));
    await vectorMemoryStore.addMemory(summaryContent, {
      userId,
      type: 'longTerm',  // 摘要提升为长期记忆
      timestamp: Date.now(),
      importance,
      category: 'compressed_summary',
      tags: ['auto-compressed']
    }, importance);

    // ✅ 实际执行：删除原始记忆
    for (const memory of memories) {
      vectorMemoryStore.removeMemory(memory.id);
    }

    log('info', 'Summarize strategy executed', {
      userId,
      originalCount: memories.length,
      summaryTokens,
      tokensSaved: originalTokens - summaryTokens
    });

    return {
      deleted: memories.length,
      created: 1,
      tokensSaved: originalTokens - summaryTokens
    };
  }

  /**
   * 执行Update策略（更新）
   */
  private async executeUpdate(
    userId: string,
    memories: MemoryVector[]
  ): Promise<{ deleted: number; created: number; tokensSaved: number }> {
    log("debug", "Executing update strategy", {
      userId,
      memoryCount: memories.length
    });

    // 按时间排序，保留最新
    const sorted = [...memories].sort((a, b) => b.metadata.timestamp - a.metadata.timestamp);
    const latest = sorted[0];
    const outdated = sorted.slice(1);

    const latestTokens = this.estimateTokens(latest.content);
    const totalTokens = memories.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);

    // ✅ 实际执行：删除过时记忆
    for (const memory of outdated) {
      vectorMemoryStore.removeMemory(memory.id);
    }

    log('info', 'Update strategy executed', {
      userId,
      keptMemory: latest.id,
      deletedCount: outdated.length,
      tokensSaved: totalTokens - latestTokens
    });

    return {
      deleted: memories.length - 1,
      created: 0,
      tokensSaved: totalTokens - latestTokens
    };
  }

  /**
   * 执行Merge策略（合并）
   */
  private async executeMerge(
    userId: string,
    memories: MemoryVector[]
  ): Promise<{ deleted: number; created: number; tokensSaved: number }> {
    log("debug", "Executing merge strategy", {
      userId,
      memoryCount: memories.length
    });

    // 简化实现：合并所有内容
    const mergedContent = memories.map(m => m.content).join(' | ');

    const originalTokens = memories.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
    const mergedTokens = this.estimateTokens(mergedContent);

    // ✅ 实际执行：创建合并记忆
    const importance = Math.max(...memories.map(m => m.metadata.importance));
    await vectorMemoryStore.addMemory(mergedContent, {
      userId,
      type: memories[0].metadata.type,
      timestamp: Math.max(...memories.map(m => m.metadata.timestamp)),
      importance,
      category: 'merged',
      tags: ['auto-merged']
    }, importance);

    // ✅ 实际执行：删除原始记忆
    for (const memory of memories) {
      vectorMemoryStore.removeMemory(memory.id);
    }

    log('info', 'Merge strategy executed', {
      userId,
      originalCount: memories.length,
      mergedTokens,
      tokensSaved: originalTokens - mergedTokens
    });

    return {
      deleted: memories.length,
      created: 1,
      tokensSaved: originalTokens - mergedTokens
    };
  }

  /**
   * 执行Ignore策略（忽略删除）
   */
  private async executeIgnore(
    userId: string,
    memories: MemoryVector[]
  ): Promise<{ deleted: number; created: number; tokensSaved: number }> {
    log("debug", "Executing ignore strategy", {
      userId,
      memoryCount: memories.length
    });

    const tokensSaved = memories.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);

    // ✅ 实际执行：删除低价值记忆
    for (const memory of memories) {
      vectorMemoryStore.removeMemory(memory.id);
    }

    log('info', 'Ignore strategy executed', {
      userId,
      deletedCount: memories.length,
      tokensSaved
    });

    return {
      deleted: memories.length,
      created: 0,
      tokensSaved
    };
  }

  // ========== 辅助方法 ==========

  /**
   * 计算组相似度
   */
  private calculateGroupSimilarity(memories: MemoryVector[]): number {
    if (memories.length < 2) return 0;

    let totalSimilarity = 0;
    let comparisonCount = 0;

    for (let i = 0; i < memories.length - 1; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        if (!memories[i].embedding || !memories[j].embedding) continue;

        const similarity = this.cosineSimilarity(
          memories[i].embedding,
          memories[j].embedding
        );

        totalSimilarity += similarity;
        comparisonCount++;
      }
    }

    return comparisonCount > 0 ? totalSimilarity / comparisonCount : 0;
  }

  /**
   * 检查是否时间相关
   */
  private areTemporallyRelated(memories: MemoryVector[]): boolean {
    if (memories.length < 2) return false;

    const sorted = [...memories].sort((a, b) => a.metadata.timestamp - b.metadata.timestamp);

    const totalTimeSpan = sorted[sorted.length - 1].metadata.timestamp - sorted[0].metadata.timestamp;
    const avgGap = totalTimeSpan / (sorted.length - 1);

    // 如果平均间隔小于1小时，认为是时间相关的
    return avgGap < 60 * 60 * 1000;
  }

  /**
   * 余弦相似度
   */
  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (!vecA || !vecB || vecA.length !== vecB.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * 估算Token数
   */
  private estimateTokens(text: string): number {
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
    const others = text.length - chineseChars - englishWords * 5;

    return Math.ceil(chineseChars * 1.5 + englishWords * 1.3 + others * 0.5);
  }
}

// 导出单例实例
export const compressionEngine = new CompressionEngine();
