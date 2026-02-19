# 记忆生命周期管理系统

## 概述

JPClaw的记忆生命周期管理系统提供了完整的**升级、降级和淘汰**机制，自动管理记忆在 `shortTerm`、`midTerm` 和 `longTerm` 之间的流转。

## 核心功能

### 1. 自动升级（Upgrade）

根据访问模式自动提升记忆等级：

#### shortTerm → midTerm
**条件**（需同时满足）：
- 访问次数 ≥ 10次
- 访问密度 ≥ 0.5次/天
- 存活时间 ≥ 7天

**示例**：
一条关于"学习TypeScript"的记忆，在7天内被访问了15次，访问密度为2.1次/天，会自动升级为midTerm。

#### midTerm → longTerm
**条件**（需同时满足）：
- 访问次数 ≥ 50次
- 访问密度 ≥ 0.3次/天
- 存活时间 ≥ 30天

**示例**：
一条关于项目架构的记忆，在30天内被访问了60次，会升级为longTerm长期保存。

### 2. 自动降级（Downgrade）

长期不活跃的记忆会被降级：

#### longTerm → midTerm
**条件**（需同时满足）：
- 不活跃天数 > 90天
- 重要性 < 0.5

**示例**：
一条3个月未访问且重要性较低的longTerm记忆会被降级为midTerm。

#### midTerm → shortTerm
**条件**（需同时满足）：
- 不活跃天数 > 30天
- 重要性 < 0.3

**示例**：
一条1个月未访问且重要性很低的midTerm记忆会被降级为shortTerm。

### 3. 自动淘汰（Deletion）

低价值且过时的记忆会被自动删除：

#### shortTerm 删除条件
- 年龄 > 30天 **且** 重要性 < 0.1

#### midTerm 删除条件
- 年龄 > 90天 **且** 重要性 < 0.2

#### longTerm 删除条件
- 年龄 > 365天 **且** 重要性 < 0.3

**保护机制**：
- `pinned` 类型的记忆**永不删除**
- `profile` 类型的记忆**永不删除**

## 使用方法

### 手动评估单个用户

```typescript
import { enhancedMemoryManager } from "./dist/memory/enhanced-memory-manager.js";

// 评估用户记忆并返回详细结果
const result = await enhancedMemoryManager.evaluateMemoryLifecycle(userId);

console.log(`升级: ${result.upgraded} 条`);
console.log(`降级: ${result.downgraded} 条`);
console.log(`删除: ${result.deleted} 条`);
console.log(`保持: ${result.unchanged} 条`);

// 查看详细变化
result.details.upgradedMemories.forEach(m => {
  console.log(`${m.from} → ${m.to}: ${m.id}`);
});
```

### 启动定期自动评估

```typescript
// 启动定期评估（默认每24小时）
enhancedMemoryManager.startLifecycleEvaluation();

// 停止定期评估
enhancedMemoryManager.stopLifecycleEvaluation();
```

### 查看统计信息

```typescript
const stats = enhancedMemoryManager.getLifecycleStats(userId);

console.log(`总记忆数: ${stats.totalCount}`);
console.log(`shortTerm: ${stats.byType.shortTerm} 条`);
console.log(`midTerm: ${stats.byType.midTerm} 条`);
console.log(`longTerm: ${stats.byType.longTerm} 条`);

// 查看平均访问次数
console.log(`longTerm平均访问: ${stats.averageAccessCount.longTerm.toFixed(1)} 次`);
```

## 配置定制

### 修改升级规则

```typescript
import { memoryLifecycleManager } from "./dist/memory/memory-lifecycle-manager.js";

memoryLifecycleManager.updateConfig({
  upgrade: {
    shortToMid: {
      minAccessCount: 15,        // 提高访问阈值
      minAccessDensity: 1.0,     // 提高密度阈值
      minSurvivalDays: 14        // 延长存活要求
    }
  }
});
```

### 修改降级规则

```typescript
memoryLifecycleManager.updateConfig({
  downgrade: {
    longToMid: {
      maxInactiveDays: 60,       // 缩短不活跃阈值
      maxImportance: 0.4         // 提高重要性阈值
    }
  }
});
```

### 修改淘汰规则

```typescript
memoryLifecycleManager.updateConfig({
  deletion: {
    shortTerm: {
      maxAge: 60 * 24 * 60 * 60 * 1000,  // 60天
      minImportance: 0.2                  // 提高重要性阈值
    }
  }
});
```

### 修改评估间隔

```typescript
memoryLifecycleManager.updateConfig({
  evaluationInterval: 12 * 60 * 60 * 1000  // 每12小时评估一次
});

// 需要重启定期评估
enhancedMemoryManager.stopLifecycleEvaluation();
enhancedMemoryManager.startLifecycleEvaluation();
```

## 测试验证

### 运行测试脚本

```bash
# 完整测试（创建多种类型记忆并验证）
node test-memory-lifecycle.js

# 简化测试（核心功能验证）
node test-lifecycle-simple.js
```

### 测试输出示例

```
=== 记忆生命周期管理简化测试 ===

📝 步骤1: 创建shortTerm记忆并模拟高频访问
✅ 创建记忆: mem_fd66528085f8...
📊 记忆状态:
   类型: midTerm
   访问次数: 20
   年龄: 7天
   访问密度: 2.86 次/天

🔄 步骤3: 执行生命周期评估
评估结果:
  ✅ 升级: 0 条
  ⬇️  降级: 0 条
  🗑️  删除: 1 条
  ➡️  保持: 1 条

=== 测试总结 ===
✅ 升级机制: 正常工作
✅ 淘汰机制: 正常工作
✅ 核心功能验证通过！
```

## 工作原理

### 评估流程

```
1. 获取用户所有记忆
   ↓
2. 逐条评估每个记忆
   ↓
3. 计算访问密度、不活跃天数等指标
   ↓
4. 根据规则判断应采取的动作
   ├─ 升级：更新type + 提升importance
   ├─ 降级：更新type + 降低importance
   ├─ 删除：从存储中移除
   └─ 保持：不做改变
   ↓
5. 持久化更新到向量存储和BM25索引
   ↓
6. 返回评估结果统计
```

### 关键指标计算

```typescript
// 访问密度
访问密度 = 访问次数 / 存活天数

// 不活跃天数
不活跃天数 = (当前时间 - 最后访问时间) / (24 * 60 * 60 * 1000)

// 存活天数
存活天数 = (当前时间 - 创建时间) / (24 * 60 * 60 * 1000)
```

## 实现文件

### 核心文件

- **`src/js/memory/memory-lifecycle-manager.ts`** - 生命周期管理器主类
  - `evaluateUser()` - 评估单个用户记忆
  - `evaluateMemory()` - 评估单条记忆
  - `upgradeMemory()` - 执行升级
  - `downgradeMemory()` - 执行降级
  - `deleteMemory()` - 执行删除

- **`src/js/memory/enhanced-memory-manager.ts`** - 集成接口
  - `evaluateMemoryLifecycle()` - 评估入口
  - `startLifecycleEvaluation()` - 启动定期评估
  - `stopLifecycleEvaluation()` - 停止定期评估
  - `getLifecycleStats()` - 获取统计信息

- **`src/js/memory/vector-store.ts`** - 存储层支持
  - `updateMemory()` - 更新记忆元数据
  - `removeMemory()` - 删除记忆
  - `getUserMemories()` - 获取用户记忆

### 测试文件

- **`test-memory-lifecycle.js`** - 完整功能测试
- **`test-lifecycle-simple.js`** - 核心功能验证

## 最佳实践

### 1. 生产环境配置

```typescript
// 启动时初始化
import { enhancedMemoryManager } from "./memory/enhanced-memory-manager.js";

// 启动定期评估（每24小时）
enhancedMemoryManager.startLifecycleEvaluation();
```

### 2. 监控和日志

系统会自动记录所有生命周期变化：

```json
{
  "level": "info",
  "message": "Memory upgraded",
  "memoryId": "mem_abc123...",
  "from": "shortTerm",
  "to": "midTerm",
  "accessCount": 15,
  "importance": 0.7
}
```

### 3. 性能优化

- 定期评估在后台异步执行，不阻塞主线程
- 批量更新减少I/O操作
- 评估间隔可根据用户量调整（默认24小时）

### 4. 数据安全

- `pinned` 和 `profile` 类型永不删除
- 支持手动评估，可在删除前人工审核
- 所有变更都有详细日志记录

## 故障排查

### 问题：升级不生效

**检查**：
1. 确认访问次数是否达标：`memory.accessCount >= 10`
2. 确认访问密度：`accessCount / survivalDays >= 0.5`
3. 确认存活天数：`survivalDays >= 7`

### 问题：删除过于激进

**解决**：
1. 提高重要性阈值
2. 延长年龄限制
3. 检查记忆重要性评分是否合理

```typescript
memoryLifecycleManager.updateConfig({
  deletion: {
    shortTerm: {
      maxAge: 60 * 24 * 60 * 60 * 1000,  // 从30天延长到60天
      minImportance: 0.2                  // 从0.1提高到0.2
    }
  }
});
```

### 问题：定期评估未运行

**检查**：
```typescript
// 确认是否已启动
enhancedMemoryManager.startLifecycleEvaluation();

// 查看日志
// 应该看到: "Starting scheduled memory lifecycle evaluation"
```

## 未来扩展

### 计划功能

1. **基于LLM的智能评估** - 使用LLM判断记忆的长期价值
2. **用户行为模式学习** - 根据用户习惯动态调整规则
3. **记忆压缩** - 将多条相关记忆合并为摘要
4. **版本控制** - 记录记忆的历史变更

## 总结

JPClaw的记忆生命周期管理系统提供了：

✅ **自动升级** - shortTerm → midTerm → longTerm
✅ **自动降级** - longTerm → midTerm → shortTerm
✅ **自动淘汰** - 删除老旧低价值记忆
✅ **灵活配置** - 所有规则参数可定制
✅ **安全保护** - pinned/profile类型永不删除
✅ **定期评估** - 后台自动运行（默认24小时）
✅ **详细日志** - 记录所有变更操作

通过这套机制，系统能够：
- 自动识别高价值记忆并长期保存
- 清理过时无用的记忆释放空间
- 保持记忆库的健康和高效
- 适应用户的使用模式动态调整
