/**
 * 记忆生命周期管理器
 *
 * 功能：
 * 1. 自动升级记忆：shortTerm → midTerm → longTerm
 * 2. 自动降级记忆：longTerm → midTerm → shortTerm
 * 3. 自动淘汰低价值记忆
 * 4. 定期评估和调整
 */

import { log } from "../shared/logger.js";
import { vectorMemoryStore, type MemoryVector } from "./vector-store.js";

export type MemoryType = "shortTerm" | "midTerm" | "longTerm" | "pinned" | "profile";

export interface LifecycleEvaluationResult {
  userId: string;
  upgraded: number;
  downgraded: number;
  deleted: number;
  unchanged: number;
  details: {
    upgradedMemories: Array<{ id: string; from: MemoryType; to: MemoryType }>;
    downgradedMemories: Array<{ id: string; from: MemoryType; to: MemoryType }>;
    deletedMemories: Array<{ id: string; reason: string }>;
  };
}

export interface LifecycleConfig {
  // 升级规则配置
  upgrade: {
    shortToMid: {
      minAccessCount: number;        // 最小访问次数
      minAccessDensity: number;       // 最小访问密度（次/天）
      minSurvivalDays: number;        // 最小存活天数
    };
    midToLong: {
      minAccessCount: number;
      minAccessDensity: number;
      minSurvivalDays: number;
    };
  };

  // 降级规则配置
  downgrade: {
    longToMid: {
      maxInactiveDays: number;        // 最大不活跃天数
      maxImportance: number;          // 重要性阈值
    };
    midToShort: {
      maxInactiveDays: number;
      maxImportance: number;
    };
  };

  // 淘汰规则配置
  deletion: {
    shortTerm: {
      maxAge: number;                 // 最大存活时间（毫秒）
      minImportance: number;          // 最小重要性
    };
    midTerm: {
      maxAge: number;
      minImportance: number;
    };
    longTerm: {
      maxAge: number;
      minImportance: number;
    };
  };

  // 评估间隔
  evaluationInterval: number;         // 毫秒

  // 硬限制配置
  hardLimit: {
    maxMemoriesPerUser: number;       // 每用户最大记忆数
    enabled: boolean;                  // 是否启用硬限制
  };
}

export class MemoryLifecycleManager {
  private static instance: MemoryLifecycleManager;
  private config: LifecycleConfig;
  private evaluationTimer: NodeJS.Timeout | null = null;
  private isEvaluating = false;

  private constructor() {
    this.config = this.getDefaultConfig();
  }

  static getInstance(): MemoryLifecycleManager {
    if (!MemoryLifecycleManager.instance) {
      MemoryLifecycleManager.instance = new MemoryLifecycleManager();
    }
    return MemoryLifecycleManager.instance;
  }

  /**
   * 获取默认配置
   */
  private getDefaultConfig(): LifecycleConfig {
    return {
      upgrade: {
        shortToMid: {
          minAccessCount: 10,          // 访问10次以上
          minAccessDensity: 0.5,       // 每天至少0.5次访问
          minSurvivalDays: 7           // 存活至少7天
        },
        midToLong: {
          minAccessCount: 50,          // 访问50次以上
          minAccessDensity: 0.3,       // 每天至少0.3次访问
          minSurvivalDays: 30          // 存活至少30天
        }
      },
      downgrade: {
        longToMid: {
          maxInactiveDays: 90,         // 90天未访问
          maxImportance: 0.5           // 重要性小于0.5
        },
        midToShort: {
          maxInactiveDays: 30,         // 30天未访问
          maxImportance: 0.3           // 重要性小于0.3
        }
      },
      deletion: {
        shortTerm: {
          maxAge: 30 * 24 * 60 * 60 * 1000,   // 30天
          minImportance: 0.1
        },
        midTerm: {
          maxAge: 90 * 24 * 60 * 60 * 1000,   // 90天
          minImportance: 0.2
        },
        longTerm: {
          maxAge: 365 * 24 * 60 * 60 * 1000,  // 365天
          minImportance: 0.3
        }
      },
      evaluationInterval: 24 * 60 * 60 * 1000,  // 每24小时评估一次
      hardLimit: {
        maxMemoriesPerUser: 2000,              // 每用户最多2000条记忆
        enabled: true                           // 默认启用硬限制保护
      }
    };
  }

  /**
   * 启动定期评估
   */
  startScheduledEvaluation(): void {
    if (this.evaluationTimer) {
      log("warn", "Lifecycle evaluation already scheduled");
      return;
    }

    log("info", "Starting scheduled memory lifecycle evaluation", {
      interval: this.config.evaluationInterval
    });

    this.evaluationTimer = setInterval(async () => {
      await this.evaluateAllUsers();
    }, this.config.evaluationInterval);
  }

  /**
   * 停止定期评估
   */
  stopScheduledEvaluation(): void {
    if (this.evaluationTimer) {
      clearInterval(this.evaluationTimer);
      this.evaluationTimer = null;
      log("info", "Stopped scheduled memory lifecycle evaluation");
    }
  }

  /**
   * 评估所有用户的记忆
   */
  async evaluateAllUsers(): Promise<Map<string, LifecycleEvaluationResult>> {
    if (this.isEvaluating) {
      log("warn", "Lifecycle evaluation already in progress");
      return new Map();
    }

    this.isEvaluating = true;

    try {
      const allMemories = vectorMemoryStore.getAllMemories();
      const userIds = new Set(allMemories.map(m => m.metadata.userId));
      const results = new Map<string, LifecycleEvaluationResult>();

      for (const userId of userIds) {
        const result = await this.evaluateUser(userId);
        results.set(userId, result);
      }

      log("info", "Completed lifecycle evaluation for all users", {
        totalUsers: userIds.size,
        totalUpgraded: Array.from(results.values()).reduce((sum, r) => sum + r.upgraded, 0),
        totalDowngraded: Array.from(results.values()).reduce((sum, r) => sum + r.downgraded, 0),
        totalDeleted: Array.from(results.values()).reduce((sum, r) => sum + r.deleted, 0)
      });

      return results;
    } finally {
      this.isEvaluating = false;
    }
  }

  /**
   * 评估单个用户的记忆
   */
  async evaluateUser(userId: string): Promise<LifecycleEvaluationResult> {
    const memories = vectorMemoryStore.getUserMemories(userId);

    const result: LifecycleEvaluationResult = {
      userId,
      upgraded: 0,
      downgraded: 0,
      deleted: 0,
      unchanged: 0,
      details: {
        upgradedMemories: [],
        downgradedMemories: [],
        deletedMemories: []
      }
    };

    for (const memory of memories) {
      const action = this.evaluateMemory(memory);

      switch (action.type) {
        case "upgrade":
          await this.upgradeMemory(memory, action.targetType!);
          result.upgraded++;
          result.details.upgradedMemories.push({
            id: memory.id,
            from: memory.metadata.type,
            to: action.targetType!
          });
          break;

        case "downgrade":
          await this.downgradeMemory(memory, action.targetType!);
          result.downgraded++;
          result.details.downgradedMemories.push({
            id: memory.id,
            from: memory.metadata.type,
            to: action.targetType!
          });
          break;

        case "delete":
          await this.deleteMemory(memory, action.reason!);
          result.deleted++;
          result.details.deletedMemories.push({
            id: memory.id,
            reason: action.reason!
          });
          break;

        case "keep":
          result.unchanged++;
          break;
      }
    }

    // 硬限制保护：如果评估后仍超过最大容量，强制删除最低价值的记忆
    if (!this.config.hardLimit.enabled) {
      log("info", "Completed lifecycle evaluation for user", {
        userId,
        upgraded: result.upgraded,
        downgraded: result.downgraded,
        deleted: result.deleted,
        unchanged: result.unchanged,
        finalCount: vectorMemoryStore.getUserMemories(userId).length
      });
      return result;
    }

    const maxMemories = this.config.hardLimit.maxMemoriesPerUser;
    const remainingMemories = vectorMemoryStore.getUserMemories(userId);

    if (remainingMemories.length > maxMemories) {
      const excessCount = remainingMemories.length - maxMemories;

      log("warn", "User memory count exceeds hard limit, forcing cleanup", {
        userId,
        currentCount: remainingMemories.length,
        limit: maxMemories,
        excessCount
      });

      // 按价值排序（重要性 * 0.4 + 最近访问 * 0.3 + 访问频率 * 0.3）
      // pinned和profile类型除外
      const deletableMemories = remainingMemories
        .filter(m => m.metadata.type !== "pinned" && m.metadata.type !== "profile")
        .map(m => {
          const now = Date.now();
          const recencyScore = Math.exp(-(now - m.lastAccessed) / (30 * 24 * 60 * 60 * 1000)); // 30天衰减
          const frequencyScore = Math.min(1, m.accessCount / 100); // 最多100次
          const valueScore = m.metadata.importance * 0.4 + recencyScore * 0.3 + frequencyScore * 0.3;
          return { memory: m, valueScore };
        })
        .sort((a, b) => a.valueScore - b.valueScore); // 升序，最低价值在前

      // 强制删除最低价值的记忆
      // 注意：如果可删除记忆数量不足，尽可能删除
      const deletableCount = deletableMemories.length;
      const actualDeleteCount = Math.min(excessCount, deletableCount);
      const toDelete = deletableMemories.slice(0, actualDeleteCount);

      for (const { memory, valueScore } of toDelete) {
        await this.deleteMemory(
          memory,
          `Hard limit enforcement: value score ${valueScore.toFixed(3)} (limit ${maxMemories})`
        );
        result.deleted++;
        result.details.deletedMemories.push({
          id: memory.id,
          reason: `Forced deletion due to capacity (value: ${valueScore.toFixed(3)})`
        });
      }

      const finalCount = remainingMemories.length - toDelete.length;
      const protectedCount = remainingMemories.length - deletableCount;

      if (finalCount > maxMemories) {
        log("error", "Unable to enforce hard limit: too many protected memories", {
          userId,
          currentCount: finalCount,
          limit: maxMemories,
          protectedMemories: protectedCount,
          message: `${protectedCount} pinned/profile memories cannot be deleted`
        });
      } else {
        log("warn", "Hard limit cleanup completed", {
          userId,
          forcedDeletions: toDelete.length,
          newCount: finalCount
        });
      }
    }

    log("info", "Completed lifecycle evaluation for user", {
      userId,
      upgraded: result.upgraded,
      downgraded: result.downgraded,
      deleted: result.deleted,
      unchanged: result.unchanged,
      finalCount: vectorMemoryStore.getUserMemories(userId).length
    });

    return result;
  }

  /**
   * 评估单个记忆应该采取的行动
   */
  private evaluateMemory(memory: MemoryVector): {
    type: "upgrade" | "downgrade" | "delete" | "keep";
    targetType?: MemoryType;
    reason?: string;
  } {
    const type = memory.metadata.type;

    // pinned 和 profile 类型不参与生命周期管理
    if (type === "pinned" || type === "profile") {
      return { type: "keep" };
    }

    const now = Date.now();
    const age = now - memory.metadata.timestamp;
    const inactiveDays = (now - memory.lastAccessed) / (24 * 60 * 60 * 1000);
    const survivalDays = age / (24 * 60 * 60 * 1000);
    const accessDensity = memory.accessCount / Math.max(1, survivalDays);

    // 1. 检查是否应该删除
    const deletionConfig = this.config.deletion[type];
    if (deletionConfig) {
      if (age > deletionConfig.maxAge && memory.metadata.importance < deletionConfig.minImportance) {
        return {
          type: "delete",
          reason: `Age ${Math.floor(survivalDays)}d exceeds max ${deletionConfig.maxAge / (24 * 60 * 60 * 1000)}d, importance ${memory.metadata.importance.toFixed(2)} below ${deletionConfig.minImportance}`
        };
      }
    }

    // 2. 检查是否应该升级
    if (type === "shortTerm") {
      const config = this.config.upgrade.shortToMid;
      if (
        memory.accessCount >= config.minAccessCount &&
        accessDensity >= config.minAccessDensity &&
        survivalDays >= config.minSurvivalDays
      ) {
        return { type: "upgrade", targetType: "midTerm" };
      }
    } else if (type === "midTerm") {
      const config = this.config.upgrade.midToLong;
      if (
        memory.accessCount >= config.minAccessCount &&
        accessDensity >= config.minAccessDensity &&
        survivalDays >= config.minSurvivalDays
      ) {
        return { type: "upgrade", targetType: "longTerm" };
      }
    }

    // 3. 检查是否应该降级
    if (type === "longTerm") {
      const config = this.config.downgrade.longToMid;
      if (
        inactiveDays > config.maxInactiveDays &&
        memory.metadata.importance < config.maxImportance
      ) {
        return { type: "downgrade", targetType: "midTerm" };
      }
    } else if (type === "midTerm") {
      const config = this.config.downgrade.midToShort;
      if (
        inactiveDays > config.maxInactiveDays &&
        memory.metadata.importance < config.maxImportance
      ) {
        return { type: "downgrade", targetType: "shortTerm" };
      }
    }

    return { type: "keep" };
  }

  /**
   * 升级记忆
   */
  private async upgradeMemory(memory: MemoryVector, targetType: MemoryType): Promise<void> {
    const oldType = memory.metadata.type;

    // 更新记忆类型
    memory.metadata.type = targetType;

    // 可选：提升重要性
    memory.metadata.importance = Math.min(1.0, memory.metadata.importance + 0.1);

    // 持久化更新
    await vectorMemoryStore.updateMemory(memory.id, {
      metadata: memory.metadata
    });

    log("info", "Memory upgraded", {
      memoryId: memory.id,
      from: oldType,
      to: targetType,
      accessCount: memory.accessCount,
      importance: memory.metadata.importance.toFixed(2)
    });
  }

  /**
   * 降级记忆
   */
  private async downgradeMemory(memory: MemoryVector, targetType: MemoryType): Promise<void> {
    const oldType = memory.metadata.type;

    // 更新记忆类型
    memory.metadata.type = targetType;

    // 可选：降低重要性
    memory.metadata.importance = Math.max(0.0, memory.metadata.importance - 0.1);

    // 持久化更新
    await vectorMemoryStore.updateMemory(memory.id, {
      metadata: memory.metadata
    });

    log("info", "Memory downgraded", {
      memoryId: memory.id,
      from: oldType,
      to: targetType,
      inactiveDays: Math.floor((Date.now() - memory.lastAccessed) / (24 * 60 * 60 * 1000)),
      importance: memory.metadata.importance.toFixed(2)
    });
  }

  /**
   * 删除记忆
   */
  private async deleteMemory(memory: MemoryVector, reason: string): Promise<void> {
    await vectorMemoryStore.removeMemory(memory.id);

    log("info", "Memory deleted", {
      memoryId: memory.id,
      type: memory.metadata.type,
      reason
    });
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<LifecycleConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      upgrade: {
        ...this.config.upgrade,
        ...config.upgrade
      },
      downgrade: {
        ...this.config.downgrade,
        ...config.downgrade
      },
      deletion: {
        ...this.config.deletion,
        ...config.deletion
      }
    };

    log("info", "Lifecycle config updated", { config: this.config });
  }

  /**
   * 获取当前配置
   */
  getConfig(): LifecycleConfig {
    return { ...this.config };
  }

  /**
   * 获取记忆统计信息
   */
  getMemoryStats(userId: string): {
    totalCount: number;
    byType: Record<MemoryType, number>;
    averageImportance: Record<MemoryType, number>;
    averageAccessCount: Record<MemoryType, number>;
    averageAge: Record<MemoryType, number>;
  } {
    const memories = vectorMemoryStore.getUserMemories(userId);

    const stats = {
      totalCount: memories.length,
      byType: {
        shortTerm: 0,
        midTerm: 0,
        longTerm: 0,
        pinned: 0,
        profile: 0
      } as Record<MemoryType, number>,
      averageImportance: {
        shortTerm: 0,
        midTerm: 0,
        longTerm: 0,
        pinned: 0,
        profile: 0
      } as Record<MemoryType, number>,
      averageAccessCount: {
        shortTerm: 0,
        midTerm: 0,
        longTerm: 0,
        pinned: 0,
        profile: 0
      } as Record<MemoryType, number>,
      averageAge: {
        shortTerm: 0,
        midTerm: 0,
        longTerm: 0,
        pinned: 0,
        profile: 0
      } as Record<MemoryType, number>
    };

    const typeGroups: Record<MemoryType, MemoryVector[]> = {
      shortTerm: [],
      midTerm: [],
      longTerm: [],
      pinned: [],
      profile: []
    };

    // 分组
    for (const memory of memories) {
      const type = memory.metadata.type;
      stats.byType[type]++;
      typeGroups[type].push(memory);
    }

    // 计算平均值
    const now = Date.now();
    for (const type of Object.keys(typeGroups) as MemoryType[]) {
      const group = typeGroups[type];
      if (group.length === 0) continue;

      stats.averageImportance[type] = group.reduce((sum, m) => sum + m.metadata.importance, 0) / group.length;
      stats.averageAccessCount[type] = group.reduce((sum, m) => sum + m.accessCount, 0) / group.length;
      stats.averageAge[type] = group.reduce((sum, m) => sum + (now - m.metadata.timestamp), 0) / group.length / (24 * 60 * 60 * 1000);
    }

    return stats;
  }
}

// 导出单例
export const memoryLifecycleManager = MemoryLifecycleManager.getInstance();
