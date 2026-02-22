/**
 * Screenshot Skill
 *
 * 截取当前屏幕并返回文件附件标记，channel handler 会自动发送图片给用户。
 * 仅支持 macOS（使用系统内置 screencapture）。
 */

import fs from "node:fs";
import path from "node:path";
import { sh, ensureDir, BRAIN_DIR } from "../_shared/proactive-utils.js";

const SCREENSHOT_DIR = path.join(BRAIN_DIR, "screenshots");

export async function run(input) {
  try {
    let params = {};
    try { params = typeof input === "string" ? JSON.parse(input) : input || {}; } catch { params = {}; }

    ensureDir(SCREENSHOT_DIR);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filePath = path.join(SCREENSHOT_DIR, `screenshot-${timestamp}.png`);

    // -x 静默截图（不播声音）
    await sh(`screencapture -x "${filePath}"`);

    if (!fs.existsSync(filePath)) {
      throw new Error("截图文件未生成，screencapture 可能失败");
    }

    const caption = params.caption || `📸 电脑截屏 ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`;

    return JSON.stringify({
      type: "file_attachment",
      filePath,
      caption,
      mimeType: "image/png",
    });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error.message });
  }
}

export default run;
