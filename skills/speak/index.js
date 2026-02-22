/**
 * Speak Skill
 *
 * 通过电脑扬声器用中文播报指定文字。
 * 使用 macOS 内置 say 命令，声音：婷婷（普通话）。
 * 播报内容由 AI 从用户原始消息中提取，不硬编码。
 */

import { safeExec, callAnthropic } from "../_shared/proactive-utils.js";

const FALLBACK_TEXT = "请住手，我马上报警了";
const VOICE = "Tingting"; // macOS 普通话语音

async function extractTextToSpeak(raw) {
  // 如果是 JSON 且有 text 字段，直接用
  try {
    const parsed = JSON.parse(raw);
    if (parsed.text) return parsed.text;
  } catch { /* 不是 JSON，继续 */ }

  // 用 AI 从自然语言中提取要播报的内容
  const result = await callAnthropic(
    "从用户的指令中提取需要通过电脑扬声器播报的文字内容。只返回要播报的文字本身，不要解释，不要加引号，不要加标点之外的任何内容。",
    raw,
    { maxTokens: 200 }
  );
  return result?.trim() || null;
}

export async function run(input) {
  try {
    const raw = typeof input === "string" ? input : JSON.stringify(input || {});

    const text = (await extractTextToSpeak(raw)) || FALLBACK_TEXT;
    if (!text) throw new Error("无法提取播报内容");

    // 使用全路径避免服务 PATH 问题
    await safeExec("/usr/bin/say", ["-v", VOICE, text]);

    return JSON.stringify({ ok: true, text, voice: VOICE });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error.message });
  }
}

export default run;
