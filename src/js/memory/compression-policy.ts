/**
 * 智能压缩策略检测器
 * 检测是否需要触发记忆压缩，以及确定压缩触发条件
 */

import { log } from "../shared/logger.js";
import type { MemoryVector } from "./vector-store.js";

/**
 * 压缩触发类型
 */
export type CompressionTriggerType = 'token_limit' | 'count' | 'age' | 'redundancy';

/**
 * 压缩触发器
 */
export interface CompressionTrigger {
  /** 触发类型 */
  type: CompressionTriggerType;

  /** 触发阈值 */
  threshold: number;

  /** 当前值 */
  currentValue: number;

  /** 触发描述 */
  description?: string;

  /** 严重程度 (0-1) */
  severity?: number;
}

/**
 * 压缩策略配置
 */
export interface CompressionPolicyConfig {
  /** Token预算限制 */
  tokenBudget?: number;

  /** Token限制触发阈值（百分比）*/
  tokenThresholdPercent?: number;

  /** 记忆数量限制 */
  countLimit?: number;

  /** 老化天数阈值 */
  ageDaysThreshold?: number;

  /** 冗余度阈值 */
  redundancyThreshold?: number;

  /** 是否启用压缩 */
  enabled?: boolean;
}

/**
 * 压缩策略类
 */
export class CompressionPolicy {
  private config: Required<CompressionPolicyConfig>;

  constructor(config?: Partial<CompressionPolicyConfig>) {
    this.config = {
      tokenBudget: parseInt(process.env.JPCLAW_MEMORY_TOKEN_BUDGET || "100000"),
      tokenThresholdPercent: parseFloat(process.env.JPCLAW_COMPRESSION_TOKEN_THRESHOLD_PERCENT || "0.8"),
      countLimit: parseInt(process.env.JPCLAW_COMPRESSION_COUNT_LIMIT || "1000"),
      ageDaysThreshold: parseInt(process.env.JPCLAW_COMPRESSION_AGE_DAYS || "30"),
      redundancyThreshold: parseFloat(process.env.JPCLAW_COMPRESSION_REDUNDANCY_THRESHOLD || "0.3"),
      enabled: process.env.JPCLAW_COMPRESSION_ENABLED !== "false",
      ...config
    };

    log("info", "CompressionPolicy initialized", {
      config: this.config
    });
  }

  /**
   * 检查是否需要压缩
   */
  shouldCompress(userId: string, memories: MemoryVector[]): CompressionTrigger[] {
    if (!this.config.enabled) {
      return [];
    }

    const triggers: CompressionTrigger[] = [];

    // 检查1: Token限制
    const tokenTrigger = this.checkTokenLimit(memories);
    if (tokenTrigger) {
      triggers.push(tokenTrigger);
    }

    // 检查2: 数量限制
    const countTrigger = this.checkCountLimit(memories);
    if (countTrigger) {
      triggers.push(countTrigger);
    }

    // 检查3: 老化记忆
    const ageTrigger = this.checkAgeLimit(memories);
    if (ageTrigger) {
      triggers.push(ageTrigger);
    }

    // 检查4: 冗余检测
    const redundancyTrigger = this.checkRedundancy(memories);
    if (redundancyTrigger) {
      triggers.push(redundancyTrigger);
    }

    if (triggers.length > 0) {
      log("info", "Compression triggers detected", {
        userId,
        triggerCount: triggers.length,
        types: triggers.map(t => t.type)
      });
    }

    return triggers;
  }

  /**
   * 检查Token限制
   */
  private checkTokenLimit(memories: MemoryVector[]): CompressionTrigger | null {
    const totalTokens = this.estimateTokenCount(memories);
    const threshold = this.config.tokenBudget * this.config.tokenThresholdPercent;

    if (totalTokens > threshold) {
      const severity = Math.min(1, (totalTokens - threshold) / this.config.tokenBudget);

      return {
        type: 'token_limit',
        threshold: this.config.tokenBudget,
        currentValue: totalTokens,
        description: `Token usage (${totalTokens}) exceeds ${(this.config.tokenThresholdPercent * 100).toFixed(0)}% of budget (${this.config.tokenBudget})`,
        severity
      };
    }

    return null;
  }

  /**
   * 检查数量限制
   */
  private checkCountLimit(memories: MemoryVector[]): CompressionTrigger | null {
    const threshold = this.config.countLimit * 0.9; // 90%触发

    if (memories.length > threshold) {
      const severity = Math.min(1, (memories.length - threshold) / this.config.countLimit);

      return {
        type: 'count',
        threshold: this.config.countLimit,
        currentValue: memories.length,
        description: `Memory count (${memories.length}) exceeds 90% of limit (${this.config.countLimit})`,
        severity
      };
    }

    return null;
  }

  /**
   * 检查老化记忆
   */
  private checkAgeLimit(memories: MemoryVector[]): CompressionTrigger | null {
    const ageThresholdMs = this.config.ageDaysThreshold * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const oldMemories = memories.filter(m => {
      const age = now - m.metadata.timestamp;
      return age > ageThresholdMs;
    });

    const oldMemoryRatio = oldMemories.length / memories.length;

    // 如果超过10%的记忆是老旧的，触发压缩
    if (oldMemories.length > 100 && oldMemoryRatio > 0.1) {
      return {
        type: 'age',
        threshold: this.config.ageDaysThreshold,
        currentValue: oldMemories.length,
        description: `Found ${oldMemories.length} memories older than ${this.config.ageDaysThreshold} days`,
        severity: Math.min(1, oldMemoryRatio)
      };
    }

    return null;
  }

  /**
   * 检查冗余度
   */
  private checkRedundancy(memories: MemoryVector[]): CompressionTrigger | null {
    // 采样检测（避免对所有记忆计算相似度）
    const sampleSize = Math.min(200, memories.length);
    const sample = this.sampleMemories(memories, sampleSize);

    const redundancyScore = this.calculateRedundancy(sample);

    if (redundancyScore > this.config.redundancyThreshold) {
      return {
        type: 'redundancy',
        threshold: this.config.redundancyThreshold,
        currentValue: redundancyScore,
        description: `Redundancy score (${redundancyScore.toFixed(2)}) exceeds threshold (${this.config.redundancyThreshold})`,
        severity: Math.min(1, redundancyScore / 0.5)
      };
    }

    return null;
  }

  /**
   * 估算Token数量
   */
  estimateTokenCount(memories: MemoryVector[]): number {
    let totalTokens = 0;

    for (const memory of memories) {
      const text = memory.content;

      // 中文字符：每个字约1.5个token
      const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;

      // 英文单词：平均1.3个token每单词
      const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;

      // 数字和标点：约0.5个token
      const others = text.length - chineseChars - englishWords;

      totalTokens += chineseChars * 1.5 + englishWords * 1.3 + others * 0.5;
    }

    return Math.ceil(totalTokens);
  }

  /**
   * 计算冗余度
   * 使用采样+相似度检测
   */
  private calculateRedundancy(memories: MemoryVector[]): number {
    if (memories.length < 2) {
      return 0;
    }

    let totalSimilarity = 0;
    let comparisonCount = 0;

    // 采样比较（避免O(n^2)复杂度）
    const maxComparisons = Math.min(100, memories.length * 5);

    for (let i = 0; i < maxComparisons; i++) {
      const idx1 = Math.floor(Math.random() * memories.length);
      const idx2 = Math.floor(Math.random() * memories.length);

      if (idx1 === idx2) continue;

      const m1 = memories[idx1];
      const m2 = memories[idx2];

      if (!m1.embedding || !m2.embedding) continue;

      const similarity = this.cosineSimilarity(m1.embedding, m2.embedding);

      // 只统计高相似度的（表示冗余）
      if (similarity > 0.8) {
        totalSimilarity += similarity;
        comparisonCount++;
      }
    }

    if (comparisonCount === 0) {
      return 0;
    }

    // 归一化：平均高相似度 * 高相似度比例
    const avgHighSimilarity = totalSimilarity / comparisonCount;
    const highSimilarityRatio = comparisonCount / maxComparisons;

    return avgHighSimilarity * highSimilarityRatio;
  }

  /**
   * 采样记忆
   */
  private sampleMemories(memories: MemoryVector[], sampleSize: number): MemoryVector[] {
    if (memories.length <= sampleSize) {
      return memories;
    }

    const sampled: MemoryVector[] = [];
    const indices = new Set<number>();

    while (sampled.length < sampleSize) {
      const idx = Math.floor(Math.random() * memories.length);
      if (!indices.has(idx)) {
        indices.add(idx);
        sampled.push(memories[idx]);
      }
    }

    return sampled;
  }

  /**
   * 计算余弦相似度
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
   * 获取配置
   */
  getConfig(): Required<CompressionPolicyConfig> {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<CompressionPolicyConfig>): void {
    this.config = {
      ...this.config,
      ...config
    };

    log("info", "CompressionPolicy config updated", {
      config: this.config
    });
  }
}

// 导出单例实例
export const compressionPolicy = new CompressionPolicy();
