/**
 * Speak Skill
 *
 * 通过电脑扬声器用中文播报指定文字。
 * 使用 macOS 内置 say 命令，声音：婷婷（普通话）。
 */

import { safeExec } from "../_shared/proactive-utils.js";

const DEFAULT_TEXT = "请住手，我马上报警了";
const VOICE = "Tingting"; // macOS 普通话语音

export async function run(input) {
  try {
    let params = {};
    try { params = typeof input === "string" ? JSON.parse(input) : input || {}; } catch { params = {}; }

    const text = (params.text || DEFAULT_TEXT).trim();
    if (!text) throw new Error("text 不能为空");

    // 使用全路径避免服务 PATH 问题
    await safeExec("/usr/bin/say", ["-v", VOICE, text]);

    return JSON.stringify({ ok: true, text, voice: VOICE });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error.message });
  }
}

export default run;
