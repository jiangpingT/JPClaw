import type { ChatEngine } from "../core/engine.js";
import type { OperationResult } from "../shared/operation-result.js";
import { createSuccess, createFailureFromCode } from "../shared/operation-result.js";
import { ErrorCode } from "../shared/errors.js";
import { log } from "../shared/logger.js";
import { listSkills, runSkill } from "../skills/registry.js";
import { loadConfig } from "../shared/config.js";
import { resolveProvider } from "../providers/index.js";
import type { AgentMessage } from "../core/messages.js";
import { IntentSystem, type SkillMetadata } from "./intent-system.js";
import { generateSlotClarification } from "./slot-filler.js";

export type SkillRouterContext = {
  userId: string;
  userName: string;
  channelId: string;
  traceId?: string;
};

type RouterDecision = {
  action: "run_skill" | "model_reply";
  name?: string;
  input?: string;
  confidence?: number;
  reason?: string;
};

/**
 * 阶段3.3：AI 驱动版本（无硬编码）
 */
export async function maybeRunSkillFirstV2(
  agent: ChatEngine,
  raw: string,
  context: SkillRouterContext,
  options: { confidenceThreshold?: number } = {}
): Promise<OperationResult<string>> {
  const confidenceThreshold = options.confidenceThreshold ?? 0.72;
  const skillList = listSkills()
    .map((s) => s.manifest)
    .filter((m) => m.kind === "skill");

  if (!skillList.length) {
    return createFailureFromCode(
      ErrorCode.SKILL_NOT_FOUND,
      "No skills available",
      { traceId: context.traceId }
    );
  }

  const skills: SkillMetadata[] = skillList.map((m) => ({
    name: m.name,
    description: m.description || "",
    requiredSlots: [] // 后续可从 manifest 读取
  }));

  // 阶段3：使用两段式意图系统（替代硬编码）
  const intentSystem = new IntentSystem();

  // Stage A: 候选生成
  const candidatesResult = await intentSystem.generateCandidates(raw, skills);
  if (!candidatesResult.ok) {
    return candidatesResult; // 传播错误
  }

  const candidates = candidatesResult.data;
  if (candidates.length === 0) {
    return createFailureFromCode(
      ErrorCode.INTENT_NO_DECISION,
      "No skill candidates generated",
      { traceId: context.traceId }
    );
  }

  // Stage B: AI 决策
  const decisionResult = await intentSystem.decide(raw, candidates, skills);
  if (!decisionResult.ok) {
    return decisionResult; // 传播错误
  }

  const decision = decisionResult.data;

  // 降级到模型
  if (decision.action === "model_reply") {
    return createFailureFromCode(
      ErrorCode.INTENT_NO_DECISION,
      decision.reason,
      { traceId: context.traceId }
    );
  }

  // 需要追问
  if (decision.action === "clarify") {
    const clarification = generateSlotClarification(
      decision.skillName || "unknown",
      decision.missingSlots
    );

    return createFailureFromCode(
      ErrorCode.INTENT_MISSING_SLOTS,
      clarification,
      {
        traceId: context.traceId,
        skillName: decision.skillName,
        missingSlots: decision.missingSlots
      }
    );
  }

  // 置信度检查
  if (decision.confidence < confidenceThreshold) {
    return createFailureFromCode(
      ErrorCode.INTENT_LOW_CONFIDENCE,
      "Intent confidence too low",
      {
        traceId: context.traceId,
        confidence: decision.confidence,
        threshold: confidenceThreshold
      }
    );
  }

  const selected = skills.find((s) => s.name === decision.skillName);
  if (!selected) {
    return createFailureFromCode(
      ErrorCode.SKILL_NOT_FOUND,
      `Skill '${decision.skillName}' not found`,
      { traceId: context.traceId, skillName: decision.skillName }
    );
  }

  // 执行技能
  log("info", "skill_router.selected", {
    traceId: context.traceId,
    channelId: context.channelId,
    userId: context.userId,
    name: selected.name,
    confidence: decision.confidence,
    reason: decision.reason
  });

  try {
    const output = await runSkill(selected.name, raw);

    // 将 skill 执行结果记录到对话历史中
    if (agent.recordExternalExchange && output) {
      agent.recordExternalExchange(raw, output, context);
    }

    // 提取可读内容：如果技能返回的是 JSON，提取 result 字段展示给用户
    const result = extractReadableOutput(String(output || "").trim());
    // 在输出中添加技能名称标识，方便测试检测
    const finalResult = result ? `[skill:${selected.name}]\n${result}` : "";

    return createSuccess(finalResult, {
      source: "computed",
      skillName: selected.name,
      confidence: decision.confidence
    });
  } catch (error) {
    // 阶段1.3：任何错误都转换为 OperationResult
    log("warn", "skill_router.failed", {
      traceId: context.traceId,
      channelId: context.channelId,
      userId: context.userId,
      error: String(error),
      stack: error instanceof Error ? error.stack : undefined
    });

    return createFailureFromCode(
      ErrorCode.SKILL_EXECUTION_FAILED,
      String(error),
      { traceId: context.traceId }
    );
  }
}

/**
 * 旧版本（向后兼容）
 */
export async function maybeRunSkillFirst(
  agent: ChatEngine,
  raw: string,
  context: SkillRouterContext,
  options: { confidenceThreshold?: number } = {}
): Promise<string | null> {
  const result = await maybeRunSkillFirstV2(agent, raw, context, options);
  return result.ok ? result.data : null;
}

/**
 * 阶段3.3：已移除所有硬编码规则
 *
 * 原有的 8 条正则规则已被 IntentSystem 的 AI 驱动判定替代：
 * - 显式命令（/skills/run）→ IntentSystem.generateCandidates() 中处理
 * - 能力咨询 → AI 判断返回 []
 * - 创建技能讨论 → AI 判断返回 model_reply
 * - 技能名+动作词 → AI 语义理解
 * - Moltbook 特殊处理 → AI 从描述中理解
 * - 长文分析请求 → AI 判断返回 model_reply
 *
 * 此函数保留仅用于向后兼容旧代码
 */
function shouldTrySkillRouter(_raw: string, _skillNames: string[]): boolean {
  // 已废弃：所有判定逻辑移至 IntentSystem
  return false;
}

function parseRouterDecision(raw: string): RouterDecision | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const block = extractFirstJsonObject(text);
  if (!block) return null;
  try {
    const obj = JSON.parse(block) as {
      action?: string;
      name?: string;
      input?: string;
      confidence?: number;
      reason?: string;
    };
    if (obj.action !== "run_skill" && obj.action !== "model_reply") return null;
    return {
      action: obj.action,
      name: obj.name ? String(obj.name) : undefined,
      input: obj.input ? String(obj.input) : undefined,
      confidence: typeof obj.confidence === "number" ? obj.confidence : undefined,
      reason: obj.reason ? String(obj.reason) : undefined
    };
  } catch {
    return null;
  }
}

/**
 * 从技能输出中提取用户可读的内容
 * 如果输出是包含 result 字段的 JSON，提取 result 而非展示原始 JSON
 */
function extractReadableOutput(raw: string): string {
  if (!raw) return raw;

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      // 优先取 result 字段（web-search 等技能的标准输出格式）
      if (typeof parsed.result === "string" && parsed.result.trim()) {
        return parsed.result.trim();
      }
      // 兜底：取 text 或 content 字段
      if (typeof parsed.text === "string" && parsed.text.trim()) {
        return parsed.text.trim();
      }
      if (typeof parsed.content === "string" && parsed.content.trim()) {
        return parsed.content.trim();
      }
    }
  } catch {
    // 不是 JSON，原样返回
  }

  return raw;
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
