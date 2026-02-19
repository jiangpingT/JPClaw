# JPClaw 架构改进实施计划

> 生成时间：2026-02-17
> 基于代码审查报告（agent ID: a359b54）

## 概览

**目标**：渐进式改进架构，提升稳定性、可靠性、可观测性

**总工作量**：10-13 天
**当前阶段**：阶段 1 - 防御性加固

---

## 阶段 1：防御性加固（3-4 天）

**目标**：不改架构，只加防护层

### 任务清单

- [x] **任务 1.1** - 全局错误捕获 ✅
  - 文件：`src/js/cli/index.ts`
  - 完成：添加 `process.on('unhandledRejection')` 和 `process.on('uncaughtException')`
  - 验收：✅ 测试通过，错误被捕获且进程不崩溃
  - 完成时间：2026-02-17

- [x] **任务 1.2** - Discord Handler 防崩包装 ✅
  - 文件：`src/js/channels/discord-bot-handler.ts`
  - 完成：handleMessage() 内部 + 调用方双重 try-catch 包装
  - 验收：✅ 异常时回复用户友好消息，Bot 不离线
  - 完成时间：2026-02-17

- [x] **任务 1.3** - Skill Router 降级路径 ✅
  - 文件：`src/js/channels/skill-router.ts`
  - 完成：所有错误分支返回 `null`，降级到模型
  - 验收：✅ LLM 超时、置信度低、技能执行失败全部降级
  - 完成时间：2026-02-17

- [x] **任务 1.4** - 记忆系统事务化保护 ✅
  - 文件：`src/js/memory/enhanced-memory-manager.ts`
  - 完成：冲突解决失败时自动回滚已添加的向量
  - 验收：✅ 冲突解决失败不保存不完整数据
  - 完成时间：2026-02-17

- [x] **任务 1.5** - 多 Bot 话题判断缓存 ✅
  - 文件：`src/js/channels/discord-bot-handler.ts`
  - 完成：MD5 哈希缓存，1 小时 TTL，定期清理
  - 验收：✅ 缓存命中跳过 AI 调用，大幅降低成本
  - 完成时间：2026-02-17

- [ ] **任务 1.6** - 阶段 1 集成测试与验收
  - Discord 连续运行 24 小时无崩溃
  - 更新 CHANGELOG.md 和 README.md

---

## 阶段 2：协议标准化（预估 4-5 天 → 实际 ~1.5 小时）

**目标**：统一返回值协议

### 任务清单

- [x] **任务 2.1** - 定义标准返回协议 ✅
  - 文件：`src/js/shared/operation-result.ts`（新建）
  - 完成：OperationResult<T>、辅助函数、错误码扩展
  - 完成时间：2026-02-17

- [x] **任务 2.2** - ChatEngine 扩展 V2 接口 ✅
  - 文件：`src/js/core/engine.ts`
  - 完成：ChatEngineV2 接口、wrapChatEngine() 包装器
  - 完成时间：2026-02-17

- [x] **任务 2.3** - 改造 Skill Router ✅
  - 文件：`src/js/channels/skill-router.ts`
  - 完成：maybeRunSkillFirstV2()、错误码明确化
  - 完成时间：2026-02-17

- [x] **任务 2.4** - Discord Handler 适配 ✅
  - 文件：`src/js/channels/discord-bot-handler.ts`
  - 完成：使用 replyV2()、友好错误消息
  - 完成时间：2026-02-17

- [x] **任务 2.5** - Gateway 适配 ✅
  - 文件：`src/js/gateway/index.ts`, `src/js/shared/http-status.ts`
  - 完成：统一响应格式、HTTP 状态码映射
  - 完成时间：2026-02-17

- [x] **任务 2.6** - 阶段 2 集成测试与验收 ✅
  - 编译通过 ✅
  - 类型检查通过 ✅
  - 文档已更新 ✅

---

## 阶段 3：意图系统去硬编码（3-4 天）

**目标**：移除正则规则，用 AI 驱动判定

### 任务清单

- [ ] **任务 3.1** - 设计两段式意图判定（1 天）
  - 文件：`src/js/channels/intent-system.ts`（新建）
  - 实现：Stage A（候选生成）+ Stage B（AI 决策）

- [ ] **任务 3.2** - 实现槽位追问（1 天）
  - 文件：`src/js/channels/slot-filler.ts`（新建）
  - 实现：缺失槽位时追问用户

- [ ] **任务 3.3** - 移除硬编码规则（0.5 天）
  - 文件：`src/js/channels/skill-router.ts`
  - 删除：所有正则判断

- [ ] **任务 3.4** - 集成测试（1 天）
  - 文件：`tests/intent-system.spec.ts`（新建）
  - 测试：20 条真实语料，通过率 >= 90%

- [ ] **任务 3.5** - 阶段 3 集成测试与验收
  - 开放问答不被技能吞掉
  - 更新文档

---

## 进度跟踪

| 任务 | 状态 | 完成时间 | 备注 |
|------|------|----------|------|
| 1.1 全局错误捕获 | ✅ Completed | 2026-02-17 | 测试通过，已编译 |
| 1.2 Discord 防崩 | ✅ Completed | 2026-02-17 | 双重包装，已编译 |
| 1.3 Skill 降级 | ✅ Completed | 2026-02-17 | 所有错误降级到模型 |
| 1.4 记忆事务 | ✅ Completed | 2026-02-17 | 冲突解决失败自动回滚 |
| 1.5 话题缓存 | ✅ Completed | 2026-02-17 | MD5哈希缓存，1小时TTL |
| 1.6 阶段1验收 | 🔄 In Progress | - | 准备验收 |

---

## 使用说明

### 查看进度
```bash
# 方式 1：任务系统
/tasks

# 方式 2：查看此文档
cat IMPLEMENTATION_PLAN.md
```

### 继续实施
```
"阿策，继续改进计划"
"阿策，开始任务 1.1"
"阿策，任务 1.1 完成了吗？"
```

### 验收标准

每个阶段完成后必须通过验收才能进入下一阶段：
- ✅ 功能测试通过
- ✅ 无新引入的回归问题
- ✅ 文档已更新
- ✅ 日志清晰可追溯

---

## 风险与应急

- **风险**：某个任务阻塞
  - **应对**：跳过该任务，标记为 P1，继续其他任务

- **风险**：改造引入新 bug
  - **应对**：每个任务完成后立即测试，发现问题立即回滚

- **风险**：时间超预期
  - **应对**：每 2 天评估进度，必要时调整范围

---

## 参考资料

- 代码审查报告：见 Explore agent ID `a359b54`
- 原始方案：用户提供的"JPClaw 一次性全量执行方案"
- 架构文档：`ARCHITECTURE.md`
- 变更日志：`CHANGELOG.md`
