/**
 * Token预算管理器
 * 管理记忆系统的Token预算分配和智能选择
 */

import { log } from "../shared/logger.js";
import type { MemoryVector } from "./vector-store.js";

/**
 * 记忆分类类型（从 multimodal-types 迁移到此处）
 */
type MemoryClassificationType = 'shortTerm' | 'midTerm' | 'longTerm' | 'pinned' | 'profile';

/**
 * Token预算分配方案
 */
export interface TokenAllocation {
  /** 固定/钉住的记忆 */
  pinned: number;

  /** 用户画像 */
  profile: number;

  /** 长期记忆 */
  longTerm: number;

  /** 中期记忆 */
  midTerm: number;

  /** 短期记忆 */
  shortTerm: number;

  /** 当前上下文 */
  context: number;

  /** 保留缓冲 */
  reserved: number;
}

/**
 * 选择策略
 */
export type SelectionStrategy = 'importance' | 'recency' | 'relevance' | 'balanced';

/**
 * Token预算管理配置
 */
export interface TokenBudgetConfig {
  /** 总预算 */
  totalBudget?: number;

  /** 预算分配比例 */
  allocation?: Partial<TokenAllocation>;
}

/**
 * Token预算管理器类
 */
export class TokenBudgetManager {
  private totalBudget: number;
  private allocationRatios: TokenAllocation;

  constructor(config?: TokenBudgetConfig) {
    this.totalBudget = config?.totalBudget ||
                      parseInt(process.env.JPCLAW_MEMORY_TOKEN_BUDGET || "100000");

    // 默认分配比例
    const defaultRatios: TokenAllocation = {
      pinned: 0.10,      // 10% - 始终保留
      profile: 0.05,     // 5% - 用户画像
      longTerm: 0.30,    // 30% - 长期记忆
      midTerm: 0.20,     // 20% - 中期记忆
      shortTerm: 0.15,   // 15% - 短期记忆
      context: 0.10,     // 10% - 当前上下文
      reserved: 0.10     // 10% - 保留buffer
    };

    // 应用自定义分配（如果有）
    if (config?.allocation) {
      const customAllocation = { ...defaultRatios, ...config.allocation };
      // 归一化到1.0
      const sum = Object.values(customAllocation).reduce((a, b) => a + b, 0);
      this.allocationRatios = {} as TokenAllocation;
      for (const [key, value] of Object.entries(customAllocation)) {
        this.allocationRatios[key as keyof TokenAllocation] = value / sum;
      }
    } else {
      this.allocationRatios = defaultRatios;
    }

    log("info", "TokenBudgetManager initialized", {
      totalBudget: this.totalBudget,
      allocationRatios: this.allocationRatios
    });
  }

  /**
   * 分配Token预算
   */
  allocateBudget(userId: string): TokenAllocation {
    const allocation: TokenAllocation = {
      pinned: Math.floor(this.totalBudget * this.allocationRatios.pinned),
      profile: Math.floor(this.totalBudget * this.allocationRatios.profile),
      longTerm: Math.floor(this.totalBudget * this.allocationRatios.longTerm),
      midTerm: Math.floor(this.totalBudget * this.allocationRatios.midTerm),
      shortTerm: Math.floor(this.totalBudget * this.allocationRatios.shortTerm),
      context: Math.floor(this.totalBudget * this.allocationRatios.context),
      reserved: Math.floor(this.totalBudget * this.allocationRatios.reserved)
    };

    log("debug", "Token budget allocated", {
      userId,
      allocation
    });

    return allocation;
  }

  /**
   * 选择记忆（不超预算）
   */
  selectMemoriesWithinBudget(
    memories: MemoryVector[],
    budget: number,
    strategy: SelectionStrategy = 'importance'
  ): MemoryVector[] {
    if (memories.length === 0) {
      return [];
    }

    // 排序
    const sorted = this.sortByStrategy(memories, strategy);

    // 贪心选择
    const selected: MemoryVector[] = [];
    let usedTokens = 0;

    for (const memory of sorted) {
      const tokens = this.estimateTokens(memory.content);

      if (usedTokens + tokens <= budget) {
        selected.push(memory);
        usedTokens += tokens;
      }

      // 提前终止（如果已经用完预算）
      if (usedTokens >= budget * 0.95) {
        break;
      }
    }

    log("debug", "Memories selected within budget", {
      total: memories.length,
      selected: selected.length,
      budgetTokens: budget,
      usedTokens,
      strategy
    });

    return selected;
  }

  /**
   * 估算Token数量
   */
  estimateTokens(text: string): number {
    // 中文字符：每个字约1.5个token
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;

    // 英文单词：平均1.3个token每单词
    const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;

    // 数字和标点：约0.5个token
    const others = text.length - chineseChars - englishWords * 5; // 粗略估算英文单词长度

    const tokens = chineseChars * 1.5 + englishWords * 1.3 + others * 0.5;

    return Math.ceil(Math.max(1, tokens));
  }

  /**
   * 按策略排序记忆
   */
  private sortByStrategy(
    memories: MemoryVector[],
    strategy: SelectionStrategy
  ): MemoryVector[] {
    const sorted = [...memories]; // 创建副本

    switch (strategy) {
      case 'importance':
        return sorted.sort((a, b) =>
          b.metadata.importance - a.metadata.importance
        );

      case 'recency':
        return sorted.sort((a, b) =>
          b.metadata.timestamp - a.metadata.timestamp
        );

      case 'relevance':
        return sorted.sort((a, b) => {
          const scoreA = this.calculateRelevanceScore(a);
          const scoreB = this.calculateRelevanceScore(b);
          return scoreB - scoreA;
        });

      case 'balanced':
        return sorted.sort((a, b) => {
          const scoreA = this.calculateBalancedScore(a);
          const scoreB = this.calculateBalancedScore(b);
          return scoreB - scoreA;
        });

      default:
        return sorted;
    }
  }

  /**
   * 计算相关性评分
   */
  private calculateRelevanceScore(memory: MemoryVector): number {
    const importance = memory.metadata.importance * 0.4;
    const recency = this.calculateRecencyScore(memory) * 0.3;
    const frequency = this.calculateFrequencyScore(memory) * 0.3;

    return importance + recency + frequency;
  }

  /**
   * 计算平衡评分
   */
  private calculateBalancedScore(memory: MemoryVector): number {
    const importance = memory.metadata.importance * 0.35;
    const recency = this.calculateRecencyScore(memory) * 0.30;
    const frequency = this.calculateFrequencyScore(memory) * 0.20;
    const quality = this.calculateQualityScore(memory) * 0.15;

    return importance + recency + frequency + quality;
  }

  /**
   * 计算新鲜度评分
   */
  private calculateRecencyScore(memory: MemoryVector): number {
    const daysSince = this.daysSince(memory.metadata.timestamp);

    // 指数衰减：e^(-days/30)
    // 30天后衰减到约37%
    return Math.exp(-daysSince / 30);
  }

  /**
   * 计算频率评分
   */
  private calculateFrequencyScore(memory: MemoryVector): number {
    const accessCount = memory.accessCount || 0;

    // 归一化到0-1，使用对数缩放
    // accessCount: 0 -> 0, 1 -> 0.5, 10 -> 0.75, 100 -> 0.9
    return Math.min(1, Math.log10(accessCount + 1) / 2);
  }

  /**
   * 计算质量评分
   */
  private calculateQualityScore(memory: MemoryVector): number {
    // 基于内容长度和embedding质量（如果有）
    const hasEmbedding = !!memory.embedding;
    const contentLength = memory.content.length;

    let score = 0;

    // embedding存在性：+0.5
    if (hasEmbedding) {
      score += 0.5;
    }

    // 内容长度（理想长度50-500字符）
    if (contentLength >= 50 && contentLength <= 500) {
      score += 0.5;
    } else if (contentLength > 500) {
      score += 0.3; // 过长略微降分
    } else {
      score += contentLength / 100; // 过短按比例给分
    }

    return Math.min(1, score);
  }

  /**
   * 计算天数差
   */
  private daysSince(timestamp: number): number {
    const now = Date.now();
    const diff = now - timestamp;
    return diff / (24 * 60 * 60 * 1000);
  }

  /**
   * 估算记忆列表的总Token数
   */
  estimateTotalTokens(memories: MemoryVector[]): number {
    return memories.reduce((sum, memory) => {
      return sum + this.estimateTokens(memory.content);
    }, 0);
  }

  /**
   * 获取Token预算统计
   */
  getStatistics(memories: MemoryVector[]): {
    totalTokens: number;
    budget: number;
    usage: number;
    remaining: number;
    byType: Record<string, number>;
  } {
    const totalTokens = this.estimateTotalTokens(memories);
    const budget = this.totalBudget;
    const usage = totalTokens / budget;
    const remaining = budget - totalTokens;

    // 按类型统计
    const byType: Record<string, number> = {};
    for (const memory of memories) {
      const type = memory.metadata.type || 'unknown';
      const tokens = this.estimateTokens(memory.content);
      byType[type] = (byType[type] || 0) + tokens;
    }

    return {
      totalTokens,
      budget,
      usage,
      remaining,
      byType
    };
  }

  /**
   * 更新预算
   */
  updateBudget(newBudget: number): void {
    this.totalBudget = newBudget;
    log("info", "Token budget updated", { newBudget });
  }

  /**
   * 更新分配比例
   */
  updateAllocation(allocation: Partial<TokenAllocation>): void {
    // 合并并归一化
    const merged = { ...this.allocationRatios, ...allocation };
    const sum = Object.values(merged).reduce((a, b) => a + b, 0);

    for (const [key, value] of Object.entries(merged)) {
      this.allocationRatios[key as keyof TokenAllocation] = value / sum;
    }

    log("info", "Token allocation ratios updated", {
      allocationRatios: this.allocationRatios
    });
  }
}

// 导出单例实例
export const tokenBudgetManager = new TokenBudgetManager();
