# 快速启用记忆生命周期管理

## 步骤1：在gateway启动时初始化

修改 `src/js/gateway/index.ts`：

### 在文件顶部导入（已存在）

```typescript
// 第24行已经有这个导入
import { enhancedMemoryManager } from "../memory/enhanced-memory-manager.js";
```

### 在startGateway函数中添加启动代码

**位置**：在 `heartbeat.start(discord);` 之后（第72行后）

```typescript
export async function startGateway(): Promise<void> {
  await runGatewaySelfCheck();
  const config = loadConfig();

  // ... 现有代码 ...

  heartbeat.start(discord);

  // ========== 新增：启动记忆生命周期管理 ==========
  // 启动定期评估（每24小时自动清理和升级/降级记忆）
  try {
    enhancedMemoryManager.startLifecycleEvaluation();
    log("info", "Memory lifecycle management started", {
      interval: "24 hours",
      features: ["auto-upgrade", "auto-downgrade", "auto-cleanup"]
    });
  } catch (error) {
    logError(new JPClawError({
      code: ErrorCode.MEMORY_OPERATION_FAILED,
      message: "Failed to start memory lifecycle management",
      cause: error instanceof Error ? error : undefined
    }));
    // 不影响系统启动，继续运行
  }
  // ================================================

  const server = http.createServer(async (req, res) => {
    // ... 现有代码 ...
  });

  // ...
}
```

## 步骤2：（可选）集成到每日清理任务

如果你想在每日清理时也手动触发一次评估：

修改 `src/js/maintenance/cleanup.ts`（或在heartbeat的onDailyFirstTick中添加）：

### 在gateway/index.ts中修改heartbeat配置

**位置**：第64-70行

```typescript
const heartbeat = new HeartbeatService({
  enabled: process.env.JPCLAW_HEARTBEAT_ENABLED === "true",
  intervalMinutes: Number(process.env.JPCLAW_HEARTBEAT_INTERVAL_MINUTES || "30"),
  inboxDir: path.resolve(process.cwd(), "sessions", "inbox"),
  ownerUserId: process.env.JPCLAW_OWNER_DISCORD_ID || "1351911386602672133",
  ownerDmEnabled: process.env.JPCLAW_HEARTBEAT_OWNER_DM === "true",
  ownerDmMode:
    (process.env.JPCLAW_HEARTBEAT_DM_MODE || "important").toLowerCase() === "always"
      ? "always"
      : "important",
  startupGraceSeconds: Number(process.env.JPCLAW_HEARTBEAT_STARTUP_GRACE_SECONDS || "60"),
  disconnectDmThreshold: Number(process.env.JPCLAW_HEARTBEAT_DISCONNECT_DM_THRESHOLD || "2"),
  onDailyFirstTick: async () => {
    // ========== 现有的清理任务 ==========
    const cleanupRes = await runDailyCleanup({
      transcriptRetentionDays: Number(process.env.JPCLAW_CLEANUP_TRANSCRIPT_RETENTION_DAYS || "7"),
      logMaxBytes: Number(process.env.JPCLAW_CLEANUP_LOG_MAX_BYTES || String(5 * 1024 * 1024))
    });

    // ========== 新增：记忆生命周期评估 ==========
    try {
      log("info", "Running daily memory lifecycle evaluation...");

      // 获取所有用户并逐个评估
      const allMemories = vectorMemoryStore.getAllMemories();
      const userIds = new Set(allMemories.map(m => m.metadata.userId));

      let totalUpgraded = 0;
      let totalDowngraded = 0;
      let totalDeleted = 0;

      for (const userId of userIds) {
        const result = await enhancedMemoryManager.evaluateMemoryLifecycle(userId);
        totalUpgraded += result.upgraded;
        totalDowngraded += result.downgraded;
        totalDeleted += result.deleted;
      }

      log("info", "Daily memory lifecycle evaluation completed", {
        users: userIds.size,
        upgraded: totalUpgraded,
        downgraded: totalDowngraded,
        deleted: totalDeleted
      });

      // 添加到清理报告
      cleanupRes.push({
        task: "Memory Lifecycle",
        details: `Evaluated ${userIds.size} users: ↑${totalUpgraded} ↓${totalDowngraded} 🗑${totalDeleted}`
      });
    } catch (error) {
      log("error", "Daily memory lifecycle evaluation failed", {
        error: error instanceof Error ? error.message : String(error)
      });

      cleanupRes.push({
        task: "Memory Lifecycle",
        details: "⚠️ Failed to evaluate"
      });
    }

    return cleanupRes;
  }
});
```

## 步骤3：配置环境变量（可选）

在 `.env` 文件中添加配置：

```bash
# ========== 记忆生命周期管理配置 ==========

# 启用生命周期管理（默认启用）
JPCLAW_LIFECYCLE_ENABLED=true

# 评估间隔（毫秒）- 默认24小时
JPCLAW_LIFECYCLE_INTERVAL=86400000

# ========== 升级规则 ==========

# shortTerm → midTerm
JPCLAW_UPGRADE_SHORT_TO_MID_ACCESS=10           # 最小访问次数
JPCLAW_UPGRADE_SHORT_TO_MID_DENSITY=0.5         # 最小访问密度（次/天）
JPCLAW_UPGRADE_SHORT_TO_MID_SURVIVAL=7          # 最小存活天数

# midTerm → longTerm
JPCLAW_UPGRADE_MID_TO_LONG_ACCESS=50
JPCLAW_UPGRADE_MID_TO_LONG_DENSITY=0.3
JPCLAW_UPGRADE_MID_TO_LONG_SURVIVAL=30

# ========== 降级规则 ==========

# longTerm → midTerm
JPCLAW_DOWNGRADE_LONG_TO_MID_INACTIVE=90        # 不活跃天数
JPCLAW_DOWNGRADE_LONG_TO_MID_IMPORTANCE=0.5     # 重要性阈值

# midTerm → shortTerm
JPCLAW_DOWNGRADE_MID_TO_SHORT_INACTIVE=30
JPCLAW_DOWNGRADE_MID_TO_SHORT_IMPORTANCE=0.3

# ========== 淘汰规则 ==========

# shortTerm 删除条件
JPCLAW_DELETE_SHORT_MAX_AGE=2592000000          # 30天（毫秒）
JPCLAW_DELETE_SHORT_MIN_IMPORTANCE=0.1

# midTerm 删除条件
JPCLAW_DELETE_MID_MAX_AGE=7776000000            # 90天
JPCLAW_DELETE_MID_MIN_IMPORTANCE=0.2

# longTerm 删除条件
JPCLAW_DELETE_LONG_MAX_AGE=31536000000          # 365天
JPCLAW_DELETE_LONG_MIN_IMPORTANCE=0.3
```

## 步骤4：验证运行

### 启动系统

```bash
npm run build
npm start
```

### 查看日志

启动后应该看到：

```json
{
  "level": "info",
  "message": "Memory lifecycle management started",
  "interval": "24 hours",
  "features": ["auto-upgrade", "auto-downgrade", "auto-cleanup"],
  "time": "2026-02-14T12:00:00.000Z"
}
```

### 手动测试

```bash
# 运行测试脚本
node test-lifecycle-simple.js

# 预期输出
=== 记忆生命周期管理简化测试 ===
✅ 升级机制: 正常工作
✅ 淘汰机制: 正常工作
✅ 核心功能验证通过！
```

## 步骤5：监控运行

### 查看每日报告

系统每天会自动评估并输出日志：

```json
{
  "level": "info",
  "message": "Daily memory lifecycle evaluation completed",
  "users": 15,
  "upgraded": 23,
  "downgraded": 8,
  "deleted": 45,
  "time": "2026-02-15T02:00:00.000Z"
}
```

### API查询统计（可选）

创建管理端点 `src/js/api/memory-admin.ts`：

```typescript
import { Router } from "express";
import { enhancedMemoryManager } from "../memory/enhanced-memory-manager.js";

const router = Router();

// 查看用户记忆统计
router.get("/admin/memory/stats/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const stats = enhancedMemoryManager.getLifecycleStats(userId);

    res.json({
      success: true,
      data: {
        totalCount: stats.totalCount,
        byType: stats.byType,
        averageImportance: stats.averageImportance,
        averageAccessCount: stats.averageAccessCount,
        averageAge: stats.averageAge
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 手动触发清理
router.post("/admin/memory/cleanup/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await enhancedMemoryManager.evaluateMemoryLifecycle(userId);

    res.json({
      success: true,
      data: {
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

export default router;
```

在 `gateway/index.ts` 中注册路由：

```typescript
import memoryAdminRouter from "../api/memory-admin.js";

// 在server创建后添加
server.on("request", (req, res) => {
  if (req.url?.startsWith("/admin/memory/")) {
    memoryAdminRouter(req, res);
  }
  // ... 其他路由
});
```

## 完成！

现在你的系统已经启用了完整的记忆生命周期管理：

✅ **自动运行** - 每24小时自动评估
✅ **自动升级** - 高频访问记忆自动晋升
✅ **自动降级** - 不活跃记忆自动降级
✅ **自动淘汰** - 老旧低价值记忆自动删除
✅ **每日报告** - 在heartbeat每日清理时汇总
✅ **可配置** - 通过环境变量灵活调整
✅ **可监控** - 详细日志记录所有变更

## 常见问题

### Q: 多久会自动清理一次？

A: 默认每24小时。可通过 `JPCLAW_LIFECYCLE_INTERVAL` 环境变量调整。

### Q: 是否会误删重要记忆？

A: 不会。系统有多重保护：
- pinned和profile类型永不删除
- 删除需要同时满足年龄和重要性两个条件
- 重要性高于阈值的记忆不会删除

### Q: 如何调整清理策略？

A: 修改环境变量中的淘汰规则参数，或在代码中调用：
```typescript
import { memoryLifecycleManager } from "./memory/memory-lifecycle-manager.js";

memoryLifecycleManager.updateConfig({
  deletion: {
    shortTerm: {
      maxAge: 60 * 24 * 60 * 60 * 1000,  // 从30天延长到60天
      minImportance: 0.2                  // 从0.1提高到0.2
    }
  }
});
```

### Q: 如何查看当前记忆状态？

A: 使用API或在代码中调用：
```typescript
const stats = enhancedMemoryManager.getLifecycleStats(userId);
console.log(`总记忆数: ${stats.totalCount}`);
console.log(`shortTerm: ${stats.byType.shortTerm}`);
```

### Q: 如何临时停止自动清理？

A: 在代码中调用：
```typescript
enhancedMemoryManager.stopLifecycleEvaluation();
```

重新启动：
```typescript
enhancedMemoryManager.startLifecycleEvaluation();
```
