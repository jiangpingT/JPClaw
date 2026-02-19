# 生命周期管理器集成说明

## 系统架构概览

```
应用层（Bot/API）
    ↓
Enhanced Memory Manager (增强记忆管理器)
    ↓
┌─────────────────────────────────────┐
│  Memory Lifecycle Manager           │ ← 新增的生命周期管理器
│  (记忆生命周期管理)                 │
└─────────────────────────────────────┘
    ↓
Vector Memory Store (向量存储)
    ↓
┌──────────────┬──────────────────┐
│  Memory      │  BM25 Index      │
│  Vectors     │  (关键词检索)     │
└──────────────┴──────────────────┘
```

## 调用流程

### 1. 系统启动时自动初始化

**文件**: `src/js/bot.ts` 或 `src/js/app.ts`

```typescript
import { enhancedMemoryManager } from "./memory/enhanced-memory-manager.js";

// 启动时初始化
async function startBot() {
  // ... 其他初始化代码 ...

  // 启动定期的记忆生命周期评估（每24小时）
  enhancedMemoryManager.startLifecycleEvaluation();

  log("info", "Memory lifecycle evaluation started");
}
```

**工作原理**：
1. 调用 `startLifecycleEvaluation()`
2. Enhanced Memory Manager 内部调用 `memoryLifecycleManager.startScheduledEvaluation()`
3. 创建定时器，每24小时自动评估所有用户的记忆
4. 后台运行，不阻塞主线程

### 2. 用户交互时被动触发（可选）

**场景A：用户发送消息后**

```typescript
// 在 bot.ts 的消息处理函数中
async function handleUserMessage(userId: string, message: string) {
  // 1. 更新记忆
  await enhancedMemoryManager.updateMemory(userId, message);

  // 2. 检查是否需要立即清理（可选）
  const stats = enhancedMemoryManager.getLifecycleStats(userId);

  if (stats.totalCount > 1500) {  // 超过阈值
    log("warn", "Memory threshold exceeded, triggering cleanup", {
      userId,
      count: stats.totalCount
    });

    // 立即评估和清理
    await enhancedMemoryManager.evaluateMemoryLifecycle(userId);
  }

  // 3. 检索相关记忆继续对话
  const relevantMemories = await enhancedMemoryManager.query({
    text: message,
    userId
  });

  // ...
}
```

**场景B：定期健康检查**

```typescript
// 每小时检查一次
setInterval(async () => {
  const allUsers = getAllUserIds();

  for (const userId of allUsers) {
    const stats = enhancedMemoryManager.getLifecycleStats(userId);

    // 记录统计信息
    metrics.gauge("memory.total_count", stats.totalCount, { userId });
    metrics.gauge("memory.short_term", stats.byType.shortTerm, { userId });
    metrics.gauge("memory.mid_term", stats.byType.midTerm, { userId });
    metrics.gauge("memory.long_term", stats.byType.longTerm, { userId });

    // 告警
    if (stats.totalCount > 2000) {
      log("error", "Memory count critical", {
        userId,
        count: stats.totalCount
      });

      // 立即清理
      await enhancedMemoryManager.evaluateMemoryLifecycle(userId);
    }
  }
}, 60 * 60 * 1000);  // 每小时
```

### 3. 管理API触发（手动控制）

**文件**: `src/js/api/memory-admin.ts` (新建)

```typescript
import { Router } from "express";
import { enhancedMemoryManager } from "../memory/enhanced-memory-manager.js";

const router = Router();

// 手动触发清理
router.post("/api/memory/cleanup/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await enhancedMemoryManager.evaluateMemoryLifecycle(userId);

    res.json({
      success: true,
      result: {
        upgraded: result.upgraded,
        downgraded: result.downgraded,
        deleted: result.deleted,
        unchanged: result.unchanged
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 查看统计
router.get("/api/memory/stats/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const stats = enhancedMemoryManager.getLifecycleStats(userId);

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
```

## 内部调用链

### 完整调用流程

```
1. 用户消息到达
   ↓
2. bot.ts: handleUserMessage()
   ↓
3. enhancedMemoryManager.updateMemory(userId, message)
   │
   ├→ 提取结构化信息
   ├→ 创建向量记忆
   ├→ 检测冲突
   └→ 提取知识图谱
   ↓
4. [定时器触发 - 每24小时]
   ↓
5. memoryLifecycleManager.evaluateAllUsers()
   │
   └→ for each user:
       ↓
6.     memoryLifecycleManager.evaluateUser(userId)
       │
       └→ for each memory:
           ↓
7.         evaluateMemory(memory)  // 判断动作
           │
           ├→ upgrade? → upgradeMemory()
           │                ↓
           │             vectorMemoryStore.updateMemory()
           │                ↓
           │             vectorBM25Index.indexMemory()
           │
           ├→ downgrade? → downgradeMemory()
           │                ↓
           │             vectorMemoryStore.updateMemory()
           │
           └→ delete? → deleteMemory()
                          ↓
                       vectorMemoryStore.removeMemory()
                          ↓
                       vectorBM25Index.removeMemory()
```

## 关键代码位置

### 1. Enhanced Memory Manager

**文件**: `src/js/memory/enhanced-memory-manager.ts`

```typescript
export class EnhancedMemoryManager {
  // ...

  /**
   * 启动定期评估 - 这是入口方法
   */
  startLifecycleEvaluation(): void {
    log("info", "Starting scheduled memory lifecycle evaluation");
    memoryLifecycleManager.startScheduledEvaluation();  // ← 调用lifecycle manager
  }

  /**
   * 手动评估单个用户
   */
  async evaluateMemoryLifecycle(userId: string): Promise<LifecycleEvaluationResult> {
    try {
      log("info", "Starting memory lifecycle evaluation", { userId });

      // ← 调用lifecycle manager
      const result = await memoryLifecycleManager.evaluateUser(userId);

      log("info", "Memory lifecycle evaluation completed", {
        userId,
        upgraded: result.upgraded,
        downgraded: result.downgraded,
        deleted: result.deleted
      });

      return result;
    } catch (error) {
      logError(error);
      throw error;
    }
  }

  /**
   * 查看统计信息
   */
  getLifecycleStats(userId: string): LifecycleStats {
    // ← 调用lifecycle manager
    return memoryLifecycleManager.getMemoryStats(userId);
  }
}
```

### 2. Memory Lifecycle Manager

**文件**: `src/js/memory/memory-lifecycle-manager.ts`

```typescript
export class MemoryLifecycleManager {
  private evaluationTimer: NodeJS.Timeout | null = null;

  /**
   * 启动定期评估
   */
  startScheduledEvaluation(): void {
    if (this.evaluationTimer) {
      log("warn", "Lifecycle evaluation already scheduled");
      return;
    }

    log("info", "Starting scheduled memory lifecycle evaluation", {
      interval: this.config.evaluationInterval  // 默认24小时
    });

    // 创建定时器
    this.evaluationTimer = setInterval(async () => {
      await this.evaluateAllUsers();  // ← 评估所有用户
    }, this.config.evaluationInterval);
  }

  /**
   * 评估所有用户
   */
  async evaluateAllUsers(): Promise<Map<string, LifecycleEvaluationResult>> {
    if (this.isEvaluating) {
      log("warn", "Lifecycle evaluation already in progress");
      return new Map();
    }

    this.isEvaluating = true;

    try {
      // 1. 获取所有记忆
      const allMemories = vectorMemoryStore.getAllMemories();

      // 2. 提取所有用户ID
      const userIds = new Set(allMemories.map(m => m.metadata.userId));

      // 3. 逐个评估
      const results = new Map<string, LifecycleEvaluationResult>();

      for (const userId of userIds) {
        const result = await this.evaluateUser(userId);  // ← 评估单个用户
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
   * 评估单个用户
   */
  async evaluateUser(userId: string): Promise<LifecycleEvaluationResult> {
    // 1. 获取用户所有记忆
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

    // 2. 逐条评估
    for (const memory of memories) {
      const action = this.evaluateMemory(memory);  // ← 评估单条记忆

      // 3. 执行动作
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
          // ...
          break;

        case "delete":
          await this.deleteMemory(memory, action.reason!);
          result.deleted++;
          // ...
          break;

        case "keep":
          result.unchanged++;
          break;
      }
    }

    return result;
  }

  /**
   * 评估单条记忆应该采取的动作
   */
  private evaluateMemory(memory: MemoryVector): {
    type: "upgrade" | "downgrade" | "delete" | "keep";
    targetType?: MemoryType;
    reason?: string;
  } {
    const type = memory.metadata.type;

    // pinned和profile不参与生命周期管理
    if (type === "pinned" || type === "profile") {
      return { type: "keep" };
    }

    const now = Date.now();
    const age = now - memory.metadata.timestamp;
    const inactiveDays = (now - memory.lastAccessed) / (24 * 60 * 60 * 1000);
    const survivalDays = age / (24 * 60 * 60 * 1000);
    const accessDensity = memory.accessCount / Math.max(1, survivalDays);

    // 1. 检查删除条件
    const deletionConfig = this.config.deletion[type];
    if (deletionConfig) {
      if (age > deletionConfig.maxAge && memory.metadata.importance < deletionConfig.minImportance) {
        return {
          type: "delete",
          reason: `Age ${Math.floor(survivalDays)}d exceeds max, importance too low`
        };
      }
    }

    // 2. 检查升级条件
    if (type === "shortTerm") {
      const config = this.config.upgrade.shortToMid;
      if (
        memory.accessCount >= config.minAccessCount &&
        accessDensity >= config.minAccessDensity &&
        survivalDays >= config.minSurvivalDays
      ) {
        return { type: "upgrade", targetType: "midTerm" };
      }
    }
    // ... 其他升级逻辑

    // 3. 检查降级条件
    if (type === "longTerm") {
      const config = this.config.downgrade.longToMid;
      if (
        inactiveDays > config.maxInactiveDays &&
        memory.metadata.importance < config.maxImportance
      ) {
        return { type: "downgrade", targetType: "midTerm" };
      }
    }
    // ... 其他降级逻辑

    return { type: "keep" };
  }

  /**
   * 升级记忆
   */
  private async upgradeMemory(memory: MemoryVector, targetType: MemoryType): Promise<void> {
    const oldType = memory.metadata.type;

    // 更新类型
    memory.metadata.type = targetType;

    // 提升重要性
    memory.metadata.importance = Math.min(1.0, memory.metadata.importance + 0.1);

    // 持久化 ← 调用vector store
    await vectorMemoryStore.updateMemory(memory.id, {
      metadata: memory.metadata
    });

    log("info", "Memory upgraded", {
      memoryId: memory.id,
      from: oldType,
      to: targetType
    });
  }

  /**
   * 删除记忆
   */
  private async deleteMemory(memory: MemoryVector, reason: string): Promise<void> {
    // ← 调用vector store删除
    await vectorMemoryStore.removeMemory(memory.id);

    log("info", "Memory deleted", {
      memoryId: memory.id,
      type: memory.metadata.type,
      reason
    });
  }
}
```

### 3. Vector Memory Store

**文件**: `src/js/memory/vector-store.ts`

```typescript
export class VectorMemoryStore {
  // ...

  /**
   * 更新记忆元数据 - 被lifecycle manager调用
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

    this.markDirty();  // 标记需要保存

    // 同步更新BM25索引
    if (updates.metadata?.type) {
      await vectorBM25Index.indexMemory(vector).catch(err => {
        logError(err);
      });
    }

    log("debug", "Memory updated", {
      memoryId,
      type: vector.metadata.type
    });

    return true;
  }

  /**
   * 删除记忆 - 被lifecycle manager调用
   */
  removeMemory(memoryId: string): boolean {
    const vector = this.vectors.get(memoryId);
    if (!vector) return false;

    // 从内存中删除
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

    // 同步从BM25索引中删除
    vectorBM25Index.removeMemory(memoryId).catch(err => {
      logError(err);
    });

    return true;
  }
}
```

## 配置和控制

### 环境变量配置

**文件**: `.env`

```bash
# 启用生命周期管理
JPCLAW_LIFECYCLE_ENABLED=true

# 评估间隔（毫秒）- 默认24小时
JPCLAW_LIFECYCLE_INTERVAL=86400000

# 升级规则
JPCLAW_UPGRADE_SHORT_TO_MID_ACCESS=10
JPCLAW_UPGRADE_SHORT_TO_MID_DENSITY=0.5
JPCLAW_UPGRADE_SHORT_TO_MID_SURVIVAL=7

# 淘汰规则
JPCLAW_DELETE_SHORT_MAX_AGE=2592000000  # 30天（毫秒）
JPCLAW_DELETE_SHORT_MIN_IMPORTANCE=0.1
```

### 代码中读取配置

**文件**: `src/js/memory/memory-lifecycle-manager.ts`

```typescript
private getDefaultConfig(): LifecycleConfig {
  return {
    upgrade: {
      shortToMid: {
        minAccessCount: parseInt(process.env.JPCLAW_UPGRADE_SHORT_TO_MID_ACCESS || "10"),
        minAccessDensity: parseFloat(process.env.JPCLAW_UPGRADE_SHORT_TO_MID_DENSITY || "0.5"),
        minSurvivalDays: parseInt(process.env.JPCLAW_UPGRADE_SHORT_TO_MID_SURVIVAL || "7")
      },
      // ...
    },
    deletion: {
      shortTerm: {
        maxAge: parseInt(process.env.JPCLAW_DELETE_SHORT_MAX_AGE || String(30 * 24 * 60 * 60 * 1000)),
        minImportance: parseFloat(process.env.JPCLAW_DELETE_SHORT_MIN_IMPORTANCE || "0.1")
      },
      // ...
    },
    evaluationInterval: parseInt(process.env.JPCLAW_LIFECYCLE_INTERVAL || String(24 * 60 * 60 * 1000))
  };
}
```

## 监控和日志

### 日志输出

生命周期管理器会自动输出结构化日志：

```json
{
  "level": "info",
  "message": "Starting scheduled memory lifecycle evaluation",
  "interval": 86400000,
  "time": "2026-02-14T10:00:00.000Z"
}

{
  "level": "info",
  "message": "Completed lifecycle evaluation for all users",
  "totalUsers": 15,
  "totalUpgraded": 23,
  "totalDowngraded": 8,
  "totalDeleted": 45,
  "time": "2026-02-14T10:00:15.000Z"
}

{
  "level": "info",
  "message": "Memory upgraded",
  "memoryId": "mem_abc123...",
  "from": "shortTerm",
  "to": "midTerm",
  "accessCount": 15,
  "importance": 0.7,
  "time": "2026-02-14T10:00:10.123Z"
}

{
  "level": "info",
  "message": "Memory deleted",
  "memoryId": "mem_xyz789...",
  "type": "shortTerm",
  "reason": "Age 35d exceeds max 30d, importance 0.08 below 0.1",
  "time": "2026-02-14T10:00:12.456Z"
}
```

### Metrics监控

```typescript
import { metrics } from "../monitoring/metrics.js";

// 在evaluateUser方法中添加metrics
metrics.increment("memory.lifecycle.evaluated", memories.length, { userId });
metrics.increment("memory.lifecycle.upgraded", result.upgraded, { userId });
metrics.increment("memory.lifecycle.downgraded", result.downgraded, { userId });
metrics.increment("memory.lifecycle.deleted", result.deleted, { userId });

// 在系统监控面板中查看
// - 每小时升级/降级/删除数量
// - 各用户记忆总量趋势
// - 平均清理效率
```

## 总结

生命周期管理器的工作方式：

1. **自动启动** - bot启动时调用 `startLifecycleEvaluation()`
2. **后台运行** - 定时器每24小时自动触发
3. **全量评估** - 评估所有用户的所有记忆
4. **智能决策** - 根据访问模式和年龄判断动作
5. **持久化** - 通过vector store更新/删除记忆
6. **日志记录** - 详细记录所有变更
7. **手动触发** - 支持API/管理界面手动清理
8. **灵活配置** - 所有规则参数可通过环境变量或代码配置

**关键优势**：
- 完全自动化，无需人工干预
- 后台运行，不影响用户体验
- 可监控，可控制
- 灵活配置，适应不同场景
