/**
 * 两段式 AI 驱动意图判定系统（阶段 3.1）
 *
 * 替代硬编码的正则规则，用 AI 自主判断意图
 */

import type { ChatEngine } from "../core/engine.js";
import type { OperationResult } from "../shared/operation-result.js";
import { createSuccess, createFailureFromCode } from "../shared/operation-result.js";
import { ErrorCode } from "../shared/errors.js";
import { log } from "../shared/logger.js";
import { resolveProvider } from "../providers/index.js";
import { loadConfig } from "../shared/config.js";
import type { AgentMessage } from "../core/messages.js";

export interface SkillMetadata {
  name: string;
  description: string;
  requiredSlots?: string[];
}

export interface IntentDecision {
  /** 意图动作 */
  action: "run_skill" | "model_reply" | "clarify";
  /** 技能名称（action=run_skill 时） */
  skillName?: string;
  /** 置信度 0-1 */
  confidence: number;
  /** 缺失的必需槽位 */
  missingSlots: string[];
  /** 决策原因 */
  reason: string;
}

/**
 * 输入预处理：去除噪声，保留语义
 */
function normalizeInput(input: string): string {
  let s = input;
  // 压缩连续空白为单空格
  s = s.replace(/\s+/g, " ").trim();
  // 去除装饰性特殊符号（连续的 #、.、! 等）
  s = s.replace(/([#.!?！？。，、]{3,})/g, " ");
  // 去除中文重复字符（查查查 → 查），保留叠词（如"谢谢"只有2个不处理）
  s = s.replace(/([\u4e00-\u9fff])\1{2,}/g, "$1");
  // 最终清理多余空白
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export class IntentSystem {
  /**
   * Stage A: 候选生成（不执行）
   * 从所有技能中筛选出 0-3 个可能相关的候选
   */
  async generateCandidates(
    input: string,
    skills: SkillMetadata[]
  ): Promise<OperationResult<string[]>> {
    if (skills.length === 0) {
      return createSuccess([]);
    }

    // 命令式触发（保留，快速路径）
    const q = input.trim().toLowerCase();
    if (q.startsWith("/skills/run") || q.startsWith("/skill ")) {
      // 从命令中提取技能名
      const parts = q.split(/\s+/);
      if (parts.length > 1) {
        const skillName = parts[1];
        const match = skills.find(s => s.name.toLowerCase() === skillName);
        if (match) {
          return createSuccess([match.name]);
        }
      }
      return createSuccess([]);
    }

    const provider = resolveProvider(loadConfig());
    if (!provider) {
      return createFailureFromCode(
        ErrorCode.PROVIDER_UNAVAILABLE,
        "No provider for intent classification"
      );
    }

    // 输入预处理：去除噪声，帮助 LLM 聚焦语义
    const cleanedInput = normalizeInput(input);

    const skillList = skills.map(s => `- ${s.name}: ${s.description}`).join("\n");
    const prompt = `用户输入：${cleanedInput}

可用技能列表：
${skillList}

请根据技能描述的语义，判断用户可能想使用哪些技能（返回 0-3 个候选，按相关性排序）。

注意：
- 用户输入可能有错别字、中英文混用、口语化表达，请理解其实际意图
- 重点看技能描述与用户需求的语义匹配，而不是关键词匹配

判断标准：

返回 [] 的情况（由 AI 直接回答，不使用技能）：
- 讨论/分析/观点类问题：如"XX能否崛起"、"如何看待XX"、"XX的利弊"、"XX怎么规划"、"你觉得XX"
- 开放式问答：如"人工智能的未来是什么"、"为什么XX"、"XX和YY哪个好"
- 能力咨询：如"你有什么技能"、"你能做什么"
- 创意/写作请求：如"写一篇文章"、"编一个故事"
- 知识问答：如"XX是什么"、"解释一下XX"

返回相关技能的情况（用户需要调用技能执行操作或获取数据）：
- 查询实时信息：如"XX现在的价格"、"XX最新新闻"、"今天XX发生了什么"
- 地理位置服务：如"附近的咖啡店"、"推荐一家餐厅"、"XX在哪里"
- 天气查询：如"明天天气"、"今天气温"
- 明确的搜索指令：如"搜索XX"、"帮我查找XX的资料"
- 动作执行/仿真控制：如"叫机器狗后空翻"、"机器狗向左走10步"、"叫机器狗强化向前走"（技能描述中明确列出了触发关键词，用户命令与描述高度匹配）
- 电脑操作：含"电脑"关键字的操作指令，如"电脑截屏发给我"、"帮我截一下电脑屏幕"、"电脑现在什么状态"（"电脑"是硬触发词，不视为聊天）

关键区分：问"XX怎么样/怎么规划/能否XX"是讨论题，返回 []；问"XX的价格/天气/新闻"是数据查询，"叫XX做YY动作"或"电脑做XX"是动作执行，后两者都返回技能。

只返回 JSON 数组，例如：["web-search", "zh-map-amap"] 或 []
不要解释，只返回 JSON。`;

    try {
      const messages: AgentMessage[] = [{ role: "user", content: prompt }];
      const response = await provider.generate(messages);
      const text = response.text.trim();

      // 提取 JSON 数组
      const match = text.match(/\[[\s\S]*?\]/);
      if (!match) {
        log("warn", "intent_system.candidates.invalid_json", { response: text });
        return createSuccess([]);
      }

      const candidates = JSON.parse(match[0]) as string[];

      // 验证候选技能存在且不超过3个
      const validCandidates = candidates
        .filter(name => skills.some(s => s.name === name))
        .slice(0, 3);

      log("info", "intent_system.candidates.generated", {
        input: input.substring(0, 50),
        candidates: validCandidates
      });

      return createSuccess(validCandidates);
    } catch (error) {
      // 优化：增强错误日志，记录更多上下文
      log("error", "intent_system.candidates.failed", {
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined,
        inputLength: input.length,
        inputPreview: input.substring(0, 100), // 前 100 字符
        skillCount: skills.length,
        providerAvailable: !!provider
      });
      return createFailureFromCode(
        ErrorCode.INTENT_PARSING_FAILED,
        String(error)
      );
    }
  }

  /**
   * Stage B: AI 决策 + 置信度
   * 从候选中选择最合适的技能，检查槽位
   */
  async decide(
    input: string,
    candidates: string[],
    skills: SkillMetadata[]
  ): Promise<OperationResult<IntentDecision>> {
    // 无候选 → 直接降级到模型
    if (candidates.length === 0) {
      return createSuccess({
        action: "model_reply",
        confidence: 1.0,
        missingSlots: [],
        reason: "No skill candidates"
      });
    }

    const provider = resolveProvider(loadConfig());
    if (!provider) {
      return createFailureFromCode(
        ErrorCode.PROVIDER_UNAVAILABLE,
        "No provider for intent decision"
      );
    }

    const candidateDetails = candidates.map(name => {
      const skill = skills.find(s => s.name === name);
      if (!skill) return "";
      const slots = skill.requiredSlots?.length
        ? `必需参数：${skill.requiredSlots.join(", ")}`
        : "无必需参数";
      return `- ${name}: ${skill.description}\n  ${slots}`;
    }).join("\n\n");

    const prompt = `用户输入：${input}

候选技能：
${candidateDetails}

请判断：
1. 应该使用哪个技能？（如果都不合适，返回 "none"）
2. 置信度（0-1）
3. 缺失的必需参数（如果有）

返回 JSON：
{
  "selectedSkill": "web-search" | "none",
  "confidence": 0.85,
  "missingSlots": ["location"],
  "reason": "用户明确要求搜索"
}

只返回 JSON，不要解释。`;

    try {
      const messages: AgentMessage[] = [{ role: "user", content: prompt }];
      const response = await provider.generate(messages);
      const text = response.text.trim();

      // 提取 JSON 对象
      const match = text.match(/\{[\s\S]*?\}/);
      if (!match) {
        log("warn", "intent_system.decision.invalid_json", { response: text });
        return createSuccess({
          action: "model_reply",
          confidence: 1.0,
          missingSlots: [],
          reason: "Failed to parse LLM decision"
        });
      }

      const decision = JSON.parse(match[0]) as {
        selectedSkill: string;
        confidence: number;
        missingSlots?: string[];
        reason: string;
      };

      // none → 降级到模型
      if (decision.selectedSkill === "none" || !decision.selectedSkill) {
        return createSuccess({
          action: "model_reply",
          confidence: decision.confidence || 1.0,
          missingSlots: [],
          reason: decision.reason || "LLM decided not to use skill"
        });
      }

      // 有缺失槽位 → 需要追问
      const missingSlots = decision.missingSlots || [];
      if (missingSlots.length > 0) {
        return createSuccess({
          action: "clarify",
          skillName: decision.selectedSkill,
          confidence: decision.confidence,
          missingSlots,
          reason: decision.reason
        });
      }

      // 正常执行技能
      return createSuccess({
        action: "run_skill",
        skillName: decision.selectedSkill,
        confidence: decision.confidence,
        missingSlots: [],
        reason: decision.reason
      });
    } catch (error) {
      // 优化：增强错误日志，记录更多上下文
      log("error", "intent_system.decision.failed", {
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined,
        inputLength: input.length,
        inputPreview: input.substring(0, 100), // 前 100 字符
        candidateCount: candidates.length,
        candidates: candidates.slice(0, 3), // 前 3 个候选
        providerAvailable: !!provider
      });
      return createSuccess({
        action: "model_reply",
        confidence: 1.0,
        missingSlots: [],
        reason: `Decision error: ${String(error)}`
      });
    }
  }
}
