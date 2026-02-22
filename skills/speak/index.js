/**
 * Speak Skill
 *
 * 通过电脑扬声器用中文播报指定文字。
 * 使用 macOS 内置 say 命令，声音：婷婷（普通话）。
 */

import { sh } from "../_shared/proactive-utils.js";

const DEFAULT_TEXT = "请住手，我马上报警了";
const VOICE = "Tingting"; // macOS 普通话语音

function escapeShell(str) {
  return str.replace(/'/g, "'\\''");
}

export async function run(input) {
  try {
    let params = {};
    try { params = typeof input === "string" ? JSON.parse(input) : input || {}; } catch { params = {}; }

    const text = (params.text || DEFAULT_TEXT).trim();
    if (!text) throw new Error("text 不能为空");

    await sh(`say -v ${VOICE} '${escapeShell(text)}'`);

    return JSON.stringify({ ok: true, text, voice: VOICE });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error.message });
  }
}

export default run;
