/**
 * Camera Capture Skill
 *
 * 使用前置摄像头录制 4 秒视频，以附件形式发送给用户。
 * 仅支持 macOS（依赖 ffmpeg + AVFoundation）。
 * 设备 [0] = MacBook Pro相机（前置）
 */

import fs from "node:fs";
import path from "node:path";
import { safeExec, ensureDir, BRAIN_DIR } from "../_shared/proactive-utils.js";

const CAMERA_DIR = path.join(BRAIN_DIR, "camera");
const DURATION_SEC = 4;
const DEVICE = "0:none"; // [0]=前置摄像头，none=不录音

export async function run(_input) {
  try {
    ensureDir(CAMERA_DIR);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filePath = path.join(CAMERA_DIR, `camera-${timestamp}.mp4`);

    // 1280x720@30fps，crf28 控制文件大小，yuv420p 保证兼容性，-y 覆盖
    // 必须同时指定 framerate + video_size，AVFoundation 才能匹配到正确模式
    await safeExec("ffmpeg", [
      "-f", "avfoundation",
      "-framerate", "30",
      "-video_size", "1280x720",
      "-i", DEVICE,
      "-t", String(DURATION_SEC),
      "-vcodec", "libx264",
      "-preset", "ultrafast",
      "-crf", "28",
      "-pix_fmt", "yuv420p",
      "-y",
      filePath,
    ], { timeout: 20_000 });

    if (!fs.existsSync(filePath)) {
      throw new Error("视频文件未生成，ffmpeg 可能失败");
    }

    const timeStr = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    return JSON.stringify({
      type: "file_attachment",
      filePath,
      caption: `📹 前置摄像头 ${DURATION_SEC}s · ${timeStr}`,
      mimeType: "video/mp4",
    });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error.message });
  }
}

export default run;
