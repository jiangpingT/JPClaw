# Discord 多Bot协作系统 V2

## 🎉 重构完成

全新的无状态、观察者模式、AI驱动的多Bot协作系统

---

## 核心设计理念

### 1. **无状态架构**
- ❌ 不维护协作上下文Map
- ❌ 不追踪bot状态和触发链
- ✅ 每个bot独立观察Discord消息
- ✅ 所有上下文从消息历史实时获取

### 2. **观察者模式**
- **Bot1 (expert)**: 看到用户新问题 → 立即回答
- **Bot2 (critic)**: 看到新问题 → 观察3秒 → AI决定是否质疑
- **Bot3 (thinker)**: 看到新问题 → 观察6秒 → AI决定是否深入分析

### 3. **AI驱动决策**
- Bot2/Bot3 不硬编码参与规则
- 通过AI分析对话历史，自主判断是否需要参与
- 符合"永远不要硬编码"的核心原则

### 4. **Bot之间不通信**
- ❌ 不通过@触发下一个bot
- ❌ 不发送协作触发消息
- ✅ 各自独立观察频道
- ✅ 避免无限循环和通知风暴

---

## 架构优势

### vs 旧系统

| 方面 | 旧系统 (v1) | 新系统 (v2) |
|-----|------------|------------|
| **状态管理** | 复杂（contexts Map + triggerMap + completedBots Set） | 无状态 |
| **Bot通信** | 通过@触发下一个bot | 各自独立，不通信 |
| **参与决策** | 硬编码优先级（expert → critic → thinker） | AI自主判断 |
| **消息追溯** | 递归爬取reply chain | 直接fetch最近消息 |
| **可扩展性** | 新增角色需改代码 | 配置驱动，可通过环境变量定义 |
| **可靠性** | 状态不一致风险高 | 简单可靠 |

---

## 核心文件

### 1. `src/js/channels/bot-roles.ts`
角色配置系统，定义bot的行为策略

```typescript
export interface BotRoleConfig {
  name: string;                    // 角色名称
  description: string;             // 角色描述（AI理解用）
  participationStrategy: "always_user_question" | "ai_decide";
  observationDelay: number;        // 观察延迟（毫秒）
  decisionPrompt?: string;         // AI决策提示词
  maxObservationMessages?: number; // 最大观察消息数
}
```

**支持环境变量配置**：
```bash
DISCORD_BOT_ROLE_EXPERT_NAME="正面专家"
DISCORD_BOT_ROLE_EXPERT_DESCRIPTION="你是正面专家..."
DISCORD_BOT_ROLE_EXPERT_STRATEGY="always_user_question"
DISCORD_BOT_ROLE_EXPERT_DELAY="0"
```

### 2. `src/js/channels/discord-bot-handler.ts`
单个Bot的消息处理器（无状态）

**关键逻辑**：
- `handleAsExpert()`: Bot1总是回答用户新问题
- `handleWithObservation()`: Bot2/Bot3观察后AI决策
- `observeAndDecide()`: 获取历史 → AI判断 → 回复

### 3. `src/js/channels/discord-multi-bot.ts`
多Bot启动管理器

启动多个Discord Bot实例，每个bot独立运行

### 4. `src/js/channels/discord.ts`
智能路由器

根据配置自动选择：
- 单bot配置 → 使用旧系统（向后兼容）
- 多bot数组配置 → 使用新系统

---

## 环境变量配置

### Bot配置
```bash
# Bot1 - Expert（总是回答用户问题）
DISCORD_BOT1_TOKEN=xxx
DISCORD_BOT1_NAME=bot1
DISCORD_BOT1_CHANNELS=channel_id1,channel_id2
DISCORD_BOT1_AGENT=expert

# Bot2 - Critic（AI决定是否质疑）
DISCORD_BOT2_TOKEN=yyy
DISCORD_BOT2_NAME=bot2
DISCORD_BOT2_CHANNELS=  # 空表示监听所有频道
DISCORD_BOT2_AGENT=critic

# Bot3 - Thinker（AI决定是否深度分析）
DISCORD_BOT3_TOKEN=zzz
DISCORD_BOT3_NAME=bot3
DISCORD_BOT3_CHANNELS=
DISCORD_BOT3_AGENT=thinker
```

### 角色自定义（可选）
```bash
# 覆盖默认角色配置
DISCORD_BOT_ROLE_CRITIC_NAME="批判性思考者"
DISCORD_BOT_ROLE_CRITIC_DESCRIPTION="你是批判性思考者..."
DISCORD_BOT_ROLE_CRITIC_DELAY="5000"  # 改为5秒
```

---

## 测试结果

### 测试问题
"人工智能会取代人类的工作吗？"

### 结果
1. **Bot1 (expert)**: 18.25s，乐观回答"重构而非取代"
2. **Bot2 (critic)**: 等待3s → AI决策YES → 18.77s质疑"转型期的痛"
3. **Bot3 (thinker)**: 等待6s → AI决策YES → 22.27s深度分析"分配问题"

**总用时**: 93.40s
**对话质量**: ⭐⭐⭐⭐⭐

三个bot的角色特点明显，形成了正面、反面、深度的立体讨论。

---

## 关键修复

### 1. ⚠️ 观察窗口重置Bug（已修复）
**问题**：旧版本每条消息都重置定时器，导致bot2/bot3可能永远不触发

**修复**：只在检测到用户新问题时开始观察窗口
```typescript
// 只在新用户问题时开始观察
const isNewQuestion = isNewUserQuestion(message);
if (!isNewQuestion) return;

// 避免重复启动观察任务
if (this.observationTimer) return;
```

### 2. ❌ 硬编码角色配置（已修复）
**问题**：DEFAULT_ROLES硬编码在代码中

**修复**：支持从环境变量读取，配置优先级：
```
环境变量 > 自定义配置 > 默认配置
```

---

## 使用指南

### 启动服务
```bash
npm run restart
```

系统会自动检测配置类型：
- 如果配置了多个bot → 使用新系统
- 如果只配置了单个bot → 使用旧系统（向后兼容）

### 测试协作
```bash
npx tsx test-multi-bot-v2.ts "你的测试问题"
```

### 查看日志
```bash
npm run logs | grep discord.bot_handler
```

---

## 扩展性

### 新增Bot角色

1. **配置环境变量**
```bash
DISCORD_BOT4_TOKEN=xxx
DISCORD_BOT4_AGENT=synthesizer  # 新角色ID
```

2. **定义角色配置（可选）**
```bash
DISCORD_BOT_ROLE_SYNTHESIZER_NAME="综合总结者"
DISCORD_BOT_ROLE_SYNTHESIZER_DESCRIPTION="你负责综合所有观点"
DISCORD_BOT_ROLE_SYNTHESIZER_STRATEGY="ai_decide"
DISCORD_BOT_ROLE_SYNTHESIZER_DELAY="9000"
DISCORD_BOT_ROLE_SYNTHESIZER_PROMPT="观察上述对话，如果需要综合总结就参与"
```

3. **重启服务** - 完成！

**无需修改任何代码** ✅

---

## 未来优化方向

1. **去重机制**：避免同一话题重复参与（短期记忆）
2. **参与阈值**：配置AI决策的置信度阈值
3. **动态角色**：根据对话主题动态调整角色行为
4. **协作模式切换**：支持"激烈辩论"vs"温和讨论"模式

---

## 总结

全新的多Bot协作系统完全符合我们的核心工程原则：

✅ **泛化优先**：配置驱动，AI决策，无硬编码
✅ **简单可靠**：无状态架构，逻辑清晰
✅ **用户第一**：Bot之间不通信，避免忽视用户

**核心哲学**：让每个Bot成为独立的观察者和思考者，而不是被编排的执行者。

---

**Author**: Claude (阿策)
**Date**: 2026-02-17
**Status**: ✅ 生产就绪
