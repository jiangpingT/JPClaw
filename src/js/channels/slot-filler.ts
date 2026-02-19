/**
 * 槽位追问系统（阶段 3.2）
 *
 * 当技能缺少必需参数时，生成友好的追问消息
 */

import { log } from "../shared/logger.js";

/**
 * 槽位问题映射（可扩展）
 */
const SLOT_QUESTIONS: Record<string, string> = {
  location: "地点是哪里？",
  keyword: "搜索关键词是什么？",
  query: "您想查询什么？",
  date: "日期是哪天？",
  time: "时间是几点？",
  url: "请提供网址",
  email: "请提供邮箱地址",
  username: "请提供用户名",
  content: "请提供内容",
  title: "请提供标题",
  description: "请提供描述"
};

/**
 * 生成槽位追问消息
 */
export function generateSlotClarification(
  skillName: string,
  missingSlots: string[]
): string {
  if (missingSlots.length === 0) {
    return "";
  }

  const questions = missingSlots.map(slot => {
    const question = SLOT_QUESTIONS[slot] || `${slot} 的值是什么？`;
    return `- ${question}`;
  });

  const message = `为了帮您执行 **${skillName}** 技能，我需要了解以下信息：\n\n${questions.join("\n")}\n\n请提供这些信息，我会继续帮您。`;

  log("info", "slot_filler.clarification_generated", {
    skillName,
    missingSlots,
    questionCount: questions.length
  });

  return message;
}

/**
 * 检查槽位是否完整
 */
export function checkRequiredSlots(
  input: string,
  requiredSlots: string[]
): string[] {
  // 简化实现：后续可用 NER 或 LLM 提取实体
  const missingSlots: string[] = [];

  for (const slot of requiredSlots) {
    // 简单的关键词检测（可扩展为 NER）
    const hasSlot = detectSlotInInput(input, slot);
    if (!hasSlot) {
      missingSlots.push(slot);
    }
  }

  return missingSlots;
}

/**
 * 检测输入中是否包含槽位值（简化版）
 */
function detectSlotInInput(input: string, slot: string): boolean {
  const normalized = input.toLowerCase();

  // 槽位特定的检测逻辑
  switch (slot) {
    case "location":
      // 检测地名关键词
      return /(?:在|位于|去|到)\s*[\u4e00-\u9fa5]{2,}/.test(normalized) ||
             /\b\w+\s+(city|street|avenue|road|place)\b/i.test(input);

    case "keyword":
    case "query":
      // 如果输入本身就是关键词，认为已提供
      return input.trim().length > 0;

    case "url":
      return /https?:\/\//.test(input);

    case "email":
      return /@.+\..+/.test(input);

    case "date":
      return /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/.test(normalized) ||
             /(今天|明天|昨天|下周|上周)/.test(normalized);

    default:
      // 默认：检查是否提到槽位名称附近有值
      const slotPattern = new RegExp(`${slot}\\s*[:：是为]\\s*\\S+`, "i");
      return slotPattern.test(input);
  }
}
