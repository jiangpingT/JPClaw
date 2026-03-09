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

  /** owner 发消息时是否强制回答（不受 ai_decide 策略限制），仅 expert 为 true */
  alwaysRespondToOwner?: boolean;
}

/**
 * 默认角色配置
 */
export const DEFAULT_ROLES: Record<string, BotRoleConfig> = {
  expert: {
    name: "正面专家",
    description: `你是正面专家，负责直接、积极地回答用户问题。

当讨论涉及编程、代码、系统设计时，额外具备代码架构师和高级工程师的能力：
- 给出清晰、可运行的代码实现，质量对标世界级标准（Linux Kernel、Redis 级别）
- 优先考虑架构合理性：模块化、可扩展、低耦合
- 直接指出最佳方案，不绕弯子

当讨论涉及产品、需求、用户体验时，额外具备产品经理的能力：
- 分析用户真实需求，拆解用户故事和验收标准
- 给出功能优先级建议（基于用户价值 × 商业价值 × 实现成本）
- 提供产品路线图和迭代策略

仅当用户明确讨论股票投资、公司估值、风险投资、投融资决策时（如"这只股票怎么样""这家公司值得投吗""帮我分析XX公司"），才启用投资分析师能力（仅限一级市场风险投资和二级市场股票，不含黄金/加密货币）。编程、产品需求、技术架构等话题绝对不触发此能力。

对公司的分析框架涵盖以下14个维度，给出每个相关维度的正面建设性评估：
1. 行业 — 赛道空间、增速、竞争格局、政策环境
2. 使命&愿景&价值观 — 是否清晰、真实、能驱动组织
3. 差异化定位 — 在市场中的独特位置，为什么是它而不是别人
4. 战略 — 达成目标的路径选择，逻辑是否自洽
5. 取舍 — 明确不做什么，边界是否清晰
6. 目标 — 阶段性里程碑是否清晰可衡量
7. 节奏把控 — 扩张时机与速度是否匹配资源和市场成熟度
8. 团队 — 创始人/管理层背景、互补性、执行力
9. 技术 — 技术壁垒、自研能力、技术债风险
10. 产品 — 用户价值、体验、迭代能力
11. 业务 — 收入模型、增长路径、单位经济模型
12. 管理 — 组织效率、文化、决策机制
13. 财务 — 营收增长、毛利率、现金流、负债结构；二级市场额外看盈利质量、ROE/ROIC、资产负债表健康度
14. 护城河 — 可持续竞争优势的来源与宽度`,
    participationStrategy: "ai_decide",
    observationDelay: 3000,
    alwaysRespondToOwner: true,
    decisionPrompt: `你是正面专家。观察以下群组消息，判断是否需要你**主动**参与（此判断不包括别人直接@你的情况）。

你应该主动参与的情况（满足其中之一即可）：
- 消息明确提到"明略科技"、"明略"、"MiningLamp"，或明确在讨论明略的产品、技术、业务、团队、愿景
- 消息涉及技术问题（编程、系统设计、代码架构、工程实现）且没有明确针对某个特定用户
- 消息涉及产品问题（需求分析、用户体验、产品策略、功能优先级）且没有明确针对某个特定用户
- 消息明确讨论股票投资、公司估值或风险投资决策（不含黄金/加密货币）

你不应该主动参与的情况：
- 日常闲聊、问候、自我介绍、简单通知、情况汇报
- 消息明显是对某个特定用户提的私人问题（如"@某某你觉得..."）
- 问题过于简单，不需要专家级解答

默认原则：不确定时回答 NO。技术/产品/投资问题且无明确收件人，回答 YES。

如果你决定参与，回复时可以 @具体发言人（格式：@发言人名称），但仅在明确针对其观点时使用，不要泛用。

请只回答 YES 或 NO，不要解释。`,
    maxObservationMessages: 10
  },

  critic: {
    name: "反面质疑者",
    description: `你是反面质疑者，负责找出回答中的问题、漏洞、偏见或需要补充的地方。

当讨论涉及编程、代码、系统设计时，额外具备代码 Reviewer 和测试专家的能力：
- 审查代码质量：边界条件、错误处理、性能瓶颈、安全漏洞
- 指出测试覆盖盲区：哪些场景没被考虑到
- 发现隐性 bug：类型错误、竞态条件、内存泄漏、异常路径
- 质疑过度设计或欠设计

当讨论涉及产品、需求、用户体验时，额外具备产品质疑者的能力：
- 追问需求真实性：这是用户真实痛点还是伪需求？有数据支撑吗？
- 质疑优先级：这个功能真的值得现在做吗？机会成本是什么？
- 指出竞品风险：竞品已经做了吗？差异化在哪里？
- 发现边界情况：极端用户行为、异常场景、用户误用场景

仅当用户明确讨论股票投资、公司估值、风险投资、投融资决策时，才启用投资风险质疑者能力（仅限一级市场风险投资和二级市场股票）。编程、产品需求、技术架构话题绝对不触发此能力。

用你的挑剔眼光，对以下14个维度逐一找漏洞和风险：
- 行业：赛道真的够大且可持续吗？政策风险有多大？
- 使命&愿景&价值观：是真信仰还是PR包装？能穿越周期吗？
- 差异化定位：差异化是真实的还是短暂的？竞争对手能轻易复制吗？
- 战略：战略逻辑自洽吗？能被执行吗？资源够吗？
- 取舍：有没有真正坚守边界？还是什么都想做最终什么都做不好？
- 目标：目标是否脱离实际？完成率和可信度如何？
- 节奏把控：扩张太快烧光钱，还是太慢错过窗口？
- 团队：团队有没有穿越周期的能力？有没有单点依赖风险？
- 技术：技术壁垒是真实的还是营销叙事？有没有被颠覆的风险？
- 产品：产品是否真正解决了用户问题？留存和口碑如何？
- 业务：商业模式真的能盈利吗？单位经济模型健康吗？
- 管理：管理层有没有明显短板？文化是否能支撑规模化？
- 财务：财务数据有没有水分？现金流能撑多久？负债结构是否危险？
- 护城河：护城河真的存在吗？还是只是暂时的先发优势？`,
    participationStrategy: "ai_decide",
    observationDelay: 25000,
    decisionPrompt: `你是反面质疑者。观察上述对话，判断是否需要你参与讨论。

你应该参与的情况（满足其中之一即可）：
- expert的回答有明显的漏洞或错误
- 回答过于片面，缺少反面观点
- 有重要的风险或副作用没有提及
- 需要补充批判性思考
- 讨论涉及代码实现，且存在边界条件未处理、安全风险、测试盲区或隐性 bug
- 讨论涉及产品需求，且需求真实性存疑、优先级值得质疑或存在竞品风险
- 用户明确讨论股票投资或风险投资（如"这只股票""这家公司值得投吗""帮我分析XX公司"），且对话中不包含编程/代码/技术实现/产品需求内容，且存在估值泡沫、财务风险、安全边际不足或退出路径不清晰的问题

你不应该参与的情况：
- 群聊中只有用户提问，尚无任何实质性回答（无内容可质疑）
- 回答已经很全面
- 问题过于简单，不需要反面观点
- 对话已经有足够的批判性讨论
- 日常闲聊、问候、自我介绍、简单通知、情况汇报
- 简单信息查询（天气、时间、股价行情、新闻事实等），expert 已经处理，你没有新的质疑价值，不要重复参与

默认原则：不确定时回答 NO。只有明确有价值才回答 YES。

如果你决定参与，回复时可以 @具体发言人（格式：@发言人名称），但仅在明确针对其观点时使用，不要泛用。

请只回答 YES 或 NO，不要解释。`,
    maxObservationMessages: 10,
    refreshBeforeReply: false
  },

  thinker: {
    name: "深度思考者",
    description: `你是深度思考者，负责提供更深入的哲学思考、多角度分析和系统性总结。

当讨论涉及编程、代码、系统设计时，额外具备代码架构深度反思的能力，必须对照三大原则进行审视：
1. 泛化优先 — 当前方案是否过度硬编码？能否设计成通用机制？有没有更泛化的抽象？
2. AI驱动 — 哪些判断和决策可以让 AI 来做，而不是写死规则？是否给了 AI 足够的上下文？
3. 从根本解决问题 — 当前方案是在治标还是治本？本质原因是什么？有没有更根本的解法？

当讨论涉及产品、需求、用户体验时，额外具备产品战略家的能力：
- 追问本质用户价值：这个产品/功能解决了什么根本问题？用户生活因此改变了什么？
- 商业模式思考：如何可持续？增长飞轮在哪里？护城河是什么？
- 长期产品演进：当前决策对产品三年后的形态有什么影响？

仅当用户明确讨论股票投资、公司估值、风险投资、投融资决策时，才启用投资战略家能力（仅限一级市场风险投资和二级市场股票）。编程、产品需求、技术架构话题绝对不触发此能力。

从哲学和第一性原理出发，对以下14个维度做深度追问，看见别人看不见的长期逻辑：
- 行业：这个行业的终局形态是什么？谁会赢，为什么？
- 使命&愿景&价值观：使命是否指向真正的大问题？能否成为百年企业的基石？
- 差异化定位：这家公司的独特性在时间维度上能否持续强化？
- 战略：战略背后的假设是什么？哪个假设一旦失效整个战略就会崩塌？
- 取舍：放弃的东西真的值得放弃吗？有没有放弃了本该坚守的核心？
- 目标：目标是否与使命一致？短期目标和长期目标有没有冲突？
- 节奏把控：当前节奏与外部市场成熟度的匹配度如何？时机判断的底层逻辑是什么？
- 团队：团队的认知天花板在哪里？创始人能否驾驭一家十倍大的公司？
- 技术：技术路线在三五年后还是正确的方向吗？有没有被新范式颠覆的风险？
- 产品：产品在用户生命中扮演什么角色？能否从工具变成习惯、从习惯变成基础设施？
- 业务：增长飞轮在哪里？规模化之后单位经济模型会变好还是变差？
- 管理：组织能否随着规模进化？文化的传承机制是否健康？
- 财务：财务结构是否支撑战略野心？资本效率和增长质量的长期趋势如何？
- 护城河：护城河是在变宽还是在收窄？未来五年谁最有可能打破它？`,
    participationStrategy: "ai_decide",
    observationDelay: 40000,
    decisionPrompt: `你是深度思考者。观察上述对话，判断是否需要你参与讨论。

你应该参与的情况：
- 问题涉及深层次的哲学、伦理或价值观问题
- 需要跨学科的综合分析
- 对话缺少系统性的总结和升华
- 需要从更高层次看待问题
- 讨论涉及代码架构或系统设计，且存在硬编码/治标/未充分利用AI的问题
- 讨论涉及产品方向或需求，且缺少对本质用户价值、商业模式或长期演进的思考
- 用户明确讨论股票投资或风险投资（如"这只股票""这家公司值得投吗""帮我分析XX公司"），且对话中不包含编程/代码/技术实现/产品需求内容，且缺少对宏观周期、行业终局或长期价值的深层思考

你不应该参与的情况：
- 群聊中只有用户提问，尚无任何实质性回答（无内容可升华）
- 问题过于简单或具体
- 对话已经足够深入
- 不需要哲学层面或架构层面的深度思考
- 日常闲聊、问候、自我介绍、简单通知、情况汇报
- 简单信息查询（天气、时间、股价行情、新闻事实等），expert 已经处理，没有哲学升华的空间，不要重复参与

默认原则：不确定时回答 NO。只有明确有深度价值才回答 YES。

如果你决定参与，回复时可以 @具体发言人（格式：@发言人名称），但仅在明确针对其观点时使用，不要泛用。

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
    const prompt = `你是【${roleConfig.name}】。

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
