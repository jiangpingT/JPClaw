# 第7次 Code Review 报告

> **日期**: 2026-02-18
> **范围**: 全项目深度审查（38,927行 TypeScript）
> **审查者**: Claude Code (阿策)
> **重点**: P0/P1 修复验证 + 新问题发现

---

## 📊 审查概要

| 严重级别 | 发现数量 | 类别 |
|---------|---------|------|
| **P0（紧急）** | 6 | 安全漏洞、资源泄漏、数据丢失 |
| **P1（重要）** | 8 | 功能缺陷、并发问题、内存管理 |
| **P2（优化）** | 8 | 代码质量、可维护性、日志规范 |
| **总计** | **22** | |

### 之前修复的验证结果

上一轮修复的8个P0/P1问题（P0-1, P0-4, P0-7, P1-8, P1-9, P1-10, P1-11）经验证**全部有效**，TypeScript 编译通过，逻辑正确。但 P1-11 背压控制中发现了一个新的边界条件问题（见 P0-NEW-2）。

---

## P0 级问题（6个）

### P0-NEW-1: LLM 网关客户端硬编码 API 密钥 🔴
**位置**: `src/js/llm/gateway-client.ts:104`
**问题**: API 密钥直接硬编码在源代码中
```typescript
"sk-A3aceakPXmTmpHZB1fD945F3C7Ea437a8809Fe7d53E5A93f"
```
**风险**: 凭证通过版本控制暴露，API 配额被滥用
**修复**: 删除硬编码密钥，强制从环境变量读取

---

### P0-NEW-2: inFlightRequests Map 内存泄漏 🔴
**位置**: `src/js/channels/discord-legacy.ts:88`
**问题**:
- 消息处理失败或异常中断时，dedupeKey 可能永不被删除
- 背压检查返回后（第440-452行），inFlightRequests 中的 key 未被清理
- 长期运行后 Map 无限增长

**场景**:
```
1. 消息 A 加入 inFlightRequests
2. 处理过程中抛出异常
3. 异常被上层 catch 捕获，但 finally 中未删除 key
4. inFlightRequests 永远保留该 key
```
**修复**: 添加 finally 块确保 key 始终被删除；添加定期清理过期条目

---

### P0-NEW-3: 沙箱子进程泄漏（僵尸进程） 🔴
**位置**: `src/js/security/sandbox.ts:543-572`
**问题**:
- 子进程清理时的 `setTimeout` handle 未保存，无法取消
- 进程正常退出后，5秒延迟的 `SIGKILL` 仍会执行
- `activeExecutions.delete()` 在 timeout 之前执行，丢失引用

**场景**:
```
t=0:   执行启动
t=0.5: 执行正常完成 → cleanupExecution() → delete from map, start 5s timeout
t=5.5: timeout 触发 SIGKILL，但 execution 已从 map 删除，无法追踪
```
**修复**: 保存 setTimeout handle，在进程正常退出时 clearTimeout

---

### P0-NEW-4: 环境变量超时值解析缺乏范围检查 🔴
**位置**: `src/js/llm/gateway-client.ts:108`
**问题**:
```typescript
this.timeout = config.timeout || Number(process.env.LLM_GATEWAY_TIMEOUT || "30000");
```
- `Number()` 解析失败返回 `NaN`，未检查
- 超时值可以是负数或异常大的值
- `NaN` 传给 `setTimeout` 导致无限等待

**修复**: 添加 `Number.isFinite()` 检查和 min/max 限制

---

### P0-NEW-5: WebSocket 连接泄漏（僵尸连接） 🔴
**位置**: `src/js/gateway/index.ts:886-896`
**问题**:
- `canvasClients` Set 中的 WebSocket 只监听 `close` 事件
- 网络断开不一定触发 `close`（半开连接问题）
- 没有心跳检测机制
- `send()` 失败时未删除 socket

**修复**: 添加 ping/pong 心跳检测；send 失败时自动删除；添加连接超时

---

### P0-NEW-6: PI 引擎静默数据丢失 🔴
**位置**: `src/js/pi/engine.ts:243-251`
**问题**:
```typescript
void enhancedMemoryManager.updateMemory(userId, input, {
  importance: 0.7,
  autoResolveConflicts: true
}).catch((error) => {
  log("warn", "pi.memory_write.failed", { error: String(error), userId });
});
```
- 记忆更新使用 `void` 显式忽略 Promise
- 如果 updateMemory 失败，用户不知道记忆未被更新
- catch 只记日志，无法恢复

**修复**: 关键路径中应 `await`；或添加重试机制和失败通知

---

## P1 级问题（8个）

### P1-NEW-1: PI 引擎 8 个 Map 内存泄漏风险
**位置**: `src/js/pi/engine.ts:39-53`
**问题**: 8个独立 Map 没有统一的清理策略，分支切换时旧 sessionKey 残留
**修复**: 创建 `SessionContext` 类统一管理

### P1-NEW-2: OpenAI Provider 缺乏重试机制
**位置**: `src/js/providers/openai.ts:22-67`
**问题**: Anthropic 有完整重试逻辑，OpenAI 没有，临时故障不可恢复
**修复**: 复用 Anthropic 的重试策略

### P1-NEW-3: 沙箱 module 限制不完整
**位置**: `src/js/security/sandbox.ts:49-51`
**问题**: 允许 `stream`、`crypto` 等模块，未限制 `require()` 相对路径
**修复**: 收紧白名单，限制路径访问

### P1-NEW-4: 向量淘汰策略硬编码且不一致
**位置**: `src/js/memory/vector-store.ts:174-208`
**问题**: 30天时间衰减与其他模块常量不一致；淘汰时机不合理
**修复**: 统一常量定义；实现周期性清理

### P1-NEW-5: 频道白名单空时无限制
**位置**: `src/js/channels/discord-legacy.ts:761-762`
**问题**: `allowedChannelIds.size > 0` 为 false 时直接放行所有频道
**修复**: 空白名单应拒绝所有请求或要求显式配置

### P1-NEW-6: RateLimitStore Map 无最大条目限制
**位置**: `src/js/security/middleware.ts:50-96`
**问题**: 大量客户端请求时 Map 无限增长，cleanup 只删过期条目
**修复**: 添加最大条目数限制 + LRU 淘汰

### P1-NEW-7: 硬编码 Discord Owner ID 多处重复
**位置**: `src/js/pi/engine.ts:383, 450, 534, 602, 831`
**问题**: `"1351911386602672133"` 在代码中出现5次，维护困难
**修复**: 提取为单一常量

### P1-NEW-8: 内存管理器并发冲突解决不原子
**位置**: `src/js/memory/enhanced-memory-manager.ts:488-536`
**问题**: 冲突解决在 for 循环中，部分成功部分失败时无法原子回滚
**修复**: 使用 Promise.all 处理所有冲突，支持原子性失败

---

## P2 级问题（8个）

| # | 问题 | 位置 | 建议 |
|---|------|------|------|
| P2-1 | 过度使用 `as any`（12处） | 多处 | 定义明确的类型 |
| P2-2 | 魔法数字未标准化（如5分钟TTL） | pi/engine.ts | 提取为命名常量 |
| P2-3 | 错误日志格式不一致 | 多处 | 统一 error 字段名 |
| P2-4 | Provider 响应格式未验证 | providers/*.ts | 添加 Zod 验证 |
| P2-5 | 网关 baseURL 未验证 | gateway-client.ts:97 | 添加 URL 验证 |
| P2-6 | 日志中可能泄露敏感信息 | discord-legacy.ts | 实现日志脱敏 |
| P2-7 | 健康检查不包含业务指标 | gateway/index.ts | 扩展检查项 |
| P2-8 | 多Bot协作缺乏去重协议 | discord-multi-bot.ts | 实现消息处理追踪 |

---

## 🎯 修复优先级排序

### 立即修复（P0 - 影响生产稳定性）

| 序号 | 问题 | 预估工作量 |
|------|------|-----------|
| 1 | P0-NEW-1: 删除硬编码 API 密钥 | 15分钟 |
| 2 | P0-NEW-2: inFlightRequests 内存泄漏 | 30分钟 |
| 3 | P0-NEW-3: 沙箱子进程泄漏 | 30分钟 |
| 4 | P0-NEW-4: 超时值解析范围检查 | 15分钟 |
| 5 | P0-NEW-5: WebSocket 僵尸连接 | 45分钟 |
| 6 | P0-NEW-6: PI 引擎静默数据丢失 | 30分钟 |

### 尽快修复（P1 - 影响可靠性）

| 序号 | 问题 | 预估工作量 |
|------|------|-----------|
| 7 | P1-NEW-7: 硬编码 Owner ID 统一 | 15分钟 |
| 8 | P1-NEW-2: OpenAI 重试机制 | 30分钟 |
| 9 | P1-NEW-5: 频道白名单安全 | 20分钟 |
| 10 | P1-NEW-6: RateLimitStore 限制 | 20分钟 |
| 11 | P1-NEW-1: 8个Map统一管理 | 2小时 |
| 12 | P1-NEW-3: 沙箱权限收紧 | 30分钟 |
| 13 | P1-NEW-4: 向量淘汰策略统一 | 30分钟 |
| 14 | P1-NEW-8: 冲突解决原子性 | 45分钟 |

---

## 📝 与第6次 Review 对比

| 指标 | 第6次 | 第7次 | 变化 |
|------|------|------|------|
| P0 问题 | 10 | 6 | ↓40% ✅ |
| P1 问题 | 11 | 8 | ↓27% ✅ |
| P2 问题 | 未统计 | 8 | - |
| 总代码行数 | ~37,000 | 38,927 | +5% |
| 安全漏洞 | 5 | 2 | ↓60% ✅ |
| 内存泄漏风险 | 4 | 3 | ↓25% ✅ |

**结论**: 上一轮 P0/P1 修复显著改善了系统质量。本次发现的问题主要集中在：
1. 之前未覆盖的模块（LLM客户端、沙箱、PI引擎）
2. 边界条件处理（超时值、Map清理）
3. 安全漏洞（硬编码密钥）

---

**更新时间**: 2026-02-18
**审查者**: Claude Code (阿策)
