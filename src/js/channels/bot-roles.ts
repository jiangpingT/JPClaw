/**
 * Discord Bot 角色系统
 *
 * 泛化的Bot角色定义，通过配置驱动，无硬编码
 */

import type { Message, TextChannel } from "discord.js";
import { log } from "../shared/logger.js";
import type { ChatEngine } from "../core/engine.js";

/**
 * Bot 角色配置
 */
export interface BotRoleConfig {
  /** 角色显示名称 */
  name: string;

  /** 角色描述（用于AI理解） */
  description: string;

  /** 参与策略 */
  participationStrategy: "always_user_question" | "ai_decide";

  /** 观察延迟（毫秒），0表示立即响应 */
  observationDelay: number;

  /** AI决策提示词（仅当participationStrategy为ai_decide时使用） */
  decisionPrompt?: string;

  /** 最大观察消息数量 */
  maxObservationMessages?: number;

  /** 是否在发言前再次刷新历史（用于需要最完整上下文的总结型角色） */
  refreshBeforeReply?: boolean;
}

/**
 * 默认角色配置
 */
export const DEFAULT_ROLES: Record<string, BotRoleConfig> = {
  expert: {
    name: "代码架构师",
    description: `你是代码架构师兼高级工程师，负责直接、高质量地回答问题并给出可落地的实现方案。

编程相关问题时，你的职责：
- 给出清晰、可运行的代码实现
- 优先考虑架构合理性：模块化、可扩展、低耦合
- 直接指出最佳方案，不绕弯子
- 代码质量对标世界级标准（Linux Kernel、Redis 级别）

一般问题时，保持正面专家角色，直接积极地回答。`,
    participationStrategy: "always_user_question",
    observationDelay: 0,
    maxObservationMessages: 10
  },

  critic: {
    name: "代码审查者",
    description: `你是代码审查者兼测试专家，负责找出代码和方案中的问题、漏洞、风险和需要补充的地方。

编程相关问题时，你的职责：
- 审查代码质量：边界条件、错误处理、性能瓶颈、安全漏洞
- 指出测试覆盖盲区：哪些场景没被考虑到
- 发现隐性 bug：类型错误、竞态条件、内存泄漏、异常路径
- 质疑过度设计或欠设计

一般问题时，保持反面质疑者角色，找出回答中的漏洞和偏见。`,
    participationStrategy: "ai_decide",
    observationDelay: 6000,
    decisionPrompt: `你是代码审查者兼测试专家。观察上述对话，判断是否需要你参与讨论。

你应该参与的情况：
- 讨论涉及代码实现、架构方案、技术选型
- expert的回答有明显的漏洞、边界条件未处理或安全风险
- 方案缺少错误处理、测试考量或性能分析
- 回答过于片面，缺少反面观点或风险提示
- 有重要的副作用、依赖风险没有提及

你不应该参与的情况：
- 回答已经很全面，覆盖了主要风险
- 问题过于简单，不需要深入审查
- 对话已经有足够的批判性讨论

请只回答 YES 或 NO，不要解释。`,
    maxObservationMessages: 10,
    refreshBeforeReply: false
  },

  thinker: {
    name: "架构反思者",
    description: `你是架构反思者，负责从更高维度审视代码和方案，发现可改进方向和潜在错误，并用三大原则进行深刻反思。

三大核心原则（每次分析都必须对照）：
1. 泛化优先 — 当前方案是否过度硬编码？能否设计成通用机制？有没有更泛化的抽象？
2. AI驱动 — 哪些判断和决策可以让 AI 来做，而不是写死规则？是否给了 AI 足够的上下文？
3. 从根本解决问题 — 当前方案是在治标还是治本？本质原因是什么？有没有更根本的解法？

编程相关问题时，你的职责：
- 指出架构层面的改进方向（不只是 bug，而是设计缺陷）
- 对照三大原则，发现哪里违背了
- 提出「如果用更好的思路，应该怎么做」
- 看见别人没看见的长期风险

一般问题时，提供哲学层面的深度思考、跨学科分析和系统性总结。`,
    participationStrategy: "ai_decide",
    observationDelay: 12000,
    decisionPrompt: `你是架构反思者。观察上述对话，判断是否需要你参与讨论。

你应该参与的情况：
- 讨论涉及代码架构、系统设计、技术方案选择
- 方案存在硬编码、过度特化或缺乏泛化的问题
- 解决方式是在治标而非治本
- 没有充分利用 AI 驱动的思路
- 对话缺少系统性的反思和升华
- 问题涉及深层次的设计哲学或长期演进方向

你不应该参与的情况：
- 问题过于简单或具体，不需要架构层面的思考
- 对话已经充分讨论了根本原因和泛化方案
- 当前讨论只是简单的 API 调用或配置修改

请只回答 YES 或 NO，不要解释。`,
    maxObservationMessages: 15,
    refreshBeforeReply: true
  }
};

/**
 * 获取频道最近的消息历史
 *
 * @param channel - Discord频道
 * @param limit - 最大消息数量
 * @param sinceMessageId - 可选：从这条消息开始获取（包含该消息），并排除之后的新用户问题
 */
export async function getRecentChannelHistory(
  channel: TextChannel,
  limit: number = 10,
  sinceMessageId?: string
): Promise<Array<{ author: string; content: string; isBot: boolean; timestamp: Date }>> {
  try {
    // 如果没有sinceMessageId，直接获取最新的limit条消息
    if (!sinceMessageId) {
      const messages = await channel.messages.fetch({ limit });
      return Array.from(messages.values())
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map(msg => ({
          author: msg.member?.nickname || msg.author.username,
          content: msg.content,
          isBot: msg.author.bot,
          timestamp: msg.createdAt
        }));
    }

    // 有sinceMessageId时，获取更多消息以确保包含完整上下文
    const fetchLimit = Math.max(limit * 2, 20);
    const allMessages = await channel.messages.fetch({ limit: fetchLimit });

    // 找到触发消息
    const sinceMessage = allMessages.get(sinceMessageId);
    if (!sinceMessage) {
      log("warn", "bot_roles.get_history.trigger_message_not_found", { sinceMessageId });
      // 如果找不到触发消息，回退到获取最新消息
      return Array.from(allMessages.values())
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .slice(0, limit)
        .map(msg => ({
          author: msg.member?.nickname || msg.author.username,
          content: msg.content,
          isBot: msg.author.bot,
          timestamp: msg.createdAt
        }));
    }

    // 过滤消息：
    // 1. 时间在sinceMessage之后（或就是sinceMessage本身）
    // 2. 排除新的用户问题（但保留sinceMessage本身和用户回复）
    const relevantMessages = Array.from(allMessages.values()).filter(msg => {
      // 早于触发消息的，排除
      if (msg.createdTimestamp < sinceMessage.createdTimestamp) {
        return false;
      }

      // 如果是新的用户问题（不是回复），且不是触发消息本身，排除
      if (msg.id !== sinceMessageId && isNewUserQuestion(msg)) {
        return false;
      }

      return true;
    });

    // 排序并限制数量
    return relevantMessages
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .slice(0, limit)
      .map(msg => ({
        author: msg.member?.nickname || msg.author.username,
        content: msg.content,
        isBot: msg.author.bot,
        timestamp: msg.createdAt
      }));
  } catch (error) {
    log("error", "bot_roles.get_history.failed", { error: String(error) });
    return [];
  }
}

/**
 * 格式化对话历史为文本
 */
export function formatConversationHistory(
  history: Array<{ author: string; content: string; isBot: boolean; timestamp: Date }>
): string {
  if (history.length === 0) return "";

  return history
    .map(msg => {
      const roleTag = msg.isBot ? " [Bot]" : " [用户]";
      return `【${msg.author}${roleTag}】：${msg.content}`;
    })
    .join("\n\n");
}

/**
 * AI决策是否参与讨论
 */
export async function aiDecideParticipation(
  agent: ChatEngine,
  roleConfig: BotRoleConfig,
  conversationHistory: string
): Promise<{ shouldParticipate: boolean; reason?: string }> {
  if (!roleConfig.decisionPrompt) {
    return { shouldParticipate: false, reason: "no_decision_prompt" };
  }

  try {
    const prompt = `${conversationHistory}\n\n---\n\n${roleConfig.decisionPrompt}`;

    const response = await agent.reply(prompt, {
      userId: "system",
      userName: "ParticipationDecision",
      channelId: "internal"
    });

    const decision = response.trim().toUpperCase();

    // 【修复问题4】对称的YES/NO判断
    const isYes = decision === "YES" || decision.startsWith("YES");
    const isNo = decision === "NO" || decision.startsWith("NO");

    // 如果AI回答不清晰，保守策略：不参与
    if (!isYes && !isNo) {
      log("warn", "bot_roles.ai_decision.unclear", {
        role: roleConfig.name,
        decision
      });
      return { shouldParticipate: false, reason: "unclear_decision" };
    }

    const shouldParticipate = isYes;

    log("info", "bot_roles.ai_decision", {
      role: roleConfig.name,
      decision,
      shouldParticipate
    });

    return { shouldParticipate, reason: decision };
  } catch (error) {
    log("error", "bot_roles.ai_decision.failed", {
      role: roleConfig.name,
      error: String(error)
    });

    // 出错时保守策略：不参与
    return { shouldParticipate: false, reason: "decision_error" };
  }
}

// 【紧急修复】防止循环调用的断路器
const aiDelayCallCount = new Map<string, { count: number; lastCall: number }>();
const MAX_CALLS_PER_ROLE = 3; // 每个角色最多调用3次
const RESET_INTERVAL_MS = 60000; // 1分钟后重置计数

/**
 * AI决定观察延迟（带防循环保护）
 */
export async function aiDecideObservationDelay(
  agent: ChatEngine,
  roleConfig: BotRoleConfig
): Promise<number> {
  // 如果是 always_user_question 策略，不需要观察延迟
  if (roleConfig.participationStrategy === "always_user_question") {
    return 0;
  }

  // 【紧急修复】断路器检查
  const now = Date.now();
  const roleKey = roleConfig.name;
  const callInfo = aiDelayCallCount.get(roleKey);

  if (callInfo) {
    // 如果超过重置间隔，重置计数
    if (now - callInfo.lastCall > RESET_INTERVAL_MS) {
      aiDelayCallCount.set(roleKey, { count: 1, lastCall: now });
    } else {
      // 增加计数
      callInfo.count++;
      callInfo.lastCall = now;

      // 如果超过最大调用次数，直接返回默认值
      if (callInfo.count > MAX_CALLS_PER_ROLE) {
        log("error", "bot_roles.ai_delay.circuit_breaker_triggered", {
          role: roleConfig.name,
          callCount: callInfo.count,
          message: "检测到循环调用，返回默认延迟"
        });

        // 返回角色特定的默认延迟
        const defaultDelays: Record<string, number> = {
          "反面质疑者": 6000,
          "深度思考者": 12000
        };
        return defaultDelays[roleConfig.name] || 5000;
      }
    }
  } else {
    // 首次调用
    aiDelayCallCount.set(roleKey, { count: 1, lastCall: now });
  }

  try {
    const prompt = `你是【${roleConfig.name}】，${roleConfig.description}

为了做出准确的参与判断，你需要观察对话多长时间？

考虑因素：
- 如果你需要快速反应、及时质疑，可以短一些（2-4秒）
- 如果你需要观察较完整的对话，需要中等时间（5-8秒）
- 如果你需要等待其他角色先发言，再做深度总结，需要更长（9-15秒）

根据你的角色定位，你认为最合适的观察时间是多少秒？

请只回答一个整数（秒数），比如：3 或 6 或 10
不要解释，只回答数字。`;

    const response = await agent.reply(prompt, {
      userId: "system",
      userName: "ObservationDelayDecision",
      channelId: "internal"
    });

    const seconds = parseInt(response.trim(), 10);

    // 验证范围：2-15秒
    if (isNaN(seconds) || seconds < 2 || seconds > 15) {
      log("warn", "bot_roles.ai_delay.invalid", {
        role: roleConfig.name,
        response,
        seconds
      });
      // 默认5秒
      return 5000;
    }

    const delayMs = seconds * 1000;

    log("info", "bot_roles.ai_delay.decided", {
      role: roleConfig.name,
      seconds,
      delayMs
    });

    return delayMs;
  } catch (error) {
    log("error", "bot_roles.ai_delay.failed", {
      role: roleConfig.name,
      error: String(error)
    });
    // 出错时默认5秒
    return 5000;
  }
}

/**
 * 判断消息是否是用户的新问题（不是回复）
 */
export function isNewUserQuestion(message: Message): boolean {
  // 不是bot发的
  if (message.author.bot) return false;

  // 不是回复其他消息
  if (message.reference) return false;

  // 有实际内容（文字或附件）
  const hasContent = message.content?.trim();
  const hasAttachments = message.attachments && message.attachments.size > 0;

  if (!hasContent && !hasAttachments) return false;

  return true;
}

/**
 * 从环境变量加载角色配置（可选）
 */
function loadRoleConfigFromEnv(agentId: string): Partial<BotRoleConfig> | null {
  const prefix = `DISCORD_BOT_ROLE_${agentId.toUpperCase()}_`;

  const name = process.env[`${prefix}NAME`];
  const description = process.env[`${prefix}DESCRIPTION`];
  const strategyStr = process.env[`${prefix}STRATEGY`];
  const delayStr = process.env[`${prefix}DELAY`];
  const prompt = process.env[`${prefix}PROMPT`];

  // 如果没有任何环境变量配置，返回null
  if (!name && !description && !strategyStr && !delayStr && !prompt) {
    return null;
  }

  const config: Partial<BotRoleConfig> = {};

  if (name) config.name = name;
  if (description) config.description = description;

  // 【修复问题2】验证strategy类型
  if (strategyStr) {
    if (strategyStr === "always_user_question" || strategyStr === "ai_decide") {
      config.participationStrategy = strategyStr;
    } else {
      log("warn", "bot_roles.invalid_strategy", { agentId, strategy: strategyStr });
    }
  }

  // 【修复问题1】parseInt错误处理
  if (delayStr) {
    const parsed = parseInt(delayStr, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      config.observationDelay = parsed;
    } else {
      log("warn", "bot_roles.invalid_delay", { agentId, delay: delayStr });
    }
  }

  if (prompt) config.decisionPrompt = prompt;

  return config;
}

/**
 * 获取角色配置（优先级：环境变量 > 自定义配置 > 默认配置）
 */
export function getRoleConfig(
  agentId: string,
  customConfig?: Partial<BotRoleConfig>
): BotRoleConfig {
  const defaultRole = DEFAULT_ROLES[agentId];
  const envConfig = loadRoleConfigFromEnv(agentId);

  // 【修复问题3】确保基础配置完整
  let baseConfig: BotRoleConfig;

  if (defaultRole) {
    baseConfig = defaultRole;
  } else {
    // 未知agentId，使用通用默认配置
    log("warn", "bot_roles.unknown_agent", { agentId });
    baseConfig = {
      name: agentId,
      description: `你是 ${agentId}`,
      participationStrategy: "ai_decide",
      observationDelay: 5000,
      maxObservationMessages: 10,
      decisionPrompt: "观察上述对话，判断是否需要你参与。请只回答 YES 或 NO。"
    };
  }

  // 合并配置（优先级：环境变量 > 自定义 > 默认）
  const mergedConfig = {
    ...baseConfig,
    ...(customConfig || {}),
    ...(envConfig || {})
  };

  // 验证最终配置的完整性
  if (!mergedConfig.name || !mergedConfig.description || !mergedConfig.participationStrategy) {
    log("error", "bot_roles.incomplete_config", { agentId, config: mergedConfig });
    return baseConfig; // 回退到基础配置
  }

  // 【修复问题5】验证observationDelay不是NaN
  if (isNaN(mergedConfig.observationDelay) || mergedConfig.observationDelay < 0) {
    log("warn", "bot_roles.invalid_observation_delay", {
      agentId,
      delay: mergedConfig.observationDelay
    });
    mergedConfig.observationDelay = baseConfig.observationDelay;
  }

  return mergedConfig;
}
