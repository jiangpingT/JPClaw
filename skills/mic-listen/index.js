/**
 * Mic Listen Skill
 *
 * 使用原生 mic-record binary（AVAudioRecorder，in-process）录制10秒麦克风音频，
 * 经 Whisper STT 转文字后用 AI 简短解读，返回 MP3 文件供 Telegram/Discord 播放。
 *
 * 为何不用 ffmpeg 录音：macOS launchd 环境下 ffmpeg 子进程受 TCC "responsible process"
 * 限制，约2.5秒后音频流被截断。mic-record 在本进程内调用 AVAudioRecorder，无此限制。
 *
 * 仅支持 macOS。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeExec, ensureDir, BRAIN_DIR, callAnthropic } from "../_shared/proactive-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIC_RECORD_BIN = path.resolve(__dirname, "../../scripts/mic-record");

const MIC_DIR = path.join(BRAIN_DIR, "mic");
const DURATION_SEC = 10;

const STT_BASE_URL = process.env.MININGLAMP_GATEWAY_BASE_URL || "https://llm-guard.mininglamp.com";
const STT_API_KEY  = process.env.MININGLAMP_GATEWAY_API_KEY || process.env.LLM_GATEWAY_API_KEY || "";
const STT_MODEL    = process.env.MININGLAMP_GATEWAY_STT_MODEL || "whisper-1";

export async function run(_input) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  let wavPath = null;
  let mp3Path = null;

  try {
    ensureDir(MIC_DIR);
    wavPath = path.join(MIC_DIR, `mic-${timestamp}.wav`);
    mp3Path = path.join(MIC_DIR, `mic-${timestamp}.mp3`);

    // Step 1：用 mic-record 录音（in-process AVAudioRecorder，无 TCC 截断问题）
    await safeExec(MIC_RECORD_BIN, [wavPath, String(DURATION_SEC)], {
      timeout: (DURATION_SEC + 5) * 1000,
    });

    if (!fs.existsSync(wavPath)) throw new Error("WAV 文件未生成");

    const wavStat = fs.statSync(wavPath);
    process.stderr.write(`[mic-listen] WAV=${wavStat.size}B\n`);

    // Step 2：PCM 静音检测，防 Whisper 对近静音产生幻觉
    const wavData = fs.readFileSync(wavPath);
    let maxSample = 0;
    for (let i = 44; i < wavData.length - 1; i += 2) {
      const s = Math.abs(wavData.readInt16LE(i));
      if (s > maxSample) maxSample = s;
    }
    if (maxSample / 32767 < 0.003) {
      return "🎤 没有听到声音（周围很安静）";
    }

    // Step 3：转 MP3（CBR 64kbps，保证播放时长正确）
    await safeExec("/opt/homebrew/bin/ffmpeg", [
      "-i", wavPath,
      "-codec:a", "libmp3lame",
      "-b:a", "64k",
      "-y",
      mp3Path,
    ], { timeout: 15_000 });

    if (!fs.existsSync(mp3Path)) throw new Error("MP3 转换失败");

    // Step 4：Whisper STT 转录
    const formData = new FormData();
    formData.append("file", new Blob([fs.readFileSync(mp3Path)], { type: "audio/mpeg" }), "mic.mp3");
    formData.append("model", STT_MODEL);
    formData.append("language", "zh");

    const sttResp = await fetch(`${STT_BASE_URL}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${STT_API_KEY}` },
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!sttResp.ok) throw new Error(`Whisper API 返回 ${sttResp.status}`);

    const sttData = await sttResp.json();
    const transcript = sttData.text?.trim() || "";

    // Step 5：AI 简短解读
    const summary = transcript
      ? await callAnthropic(
          "你是听音助手。根据下方语音转文字内容，用一句话描述：有人在说话，以及说的是什么。如果内容清晰直接复述；如果不清晰或噪音多则说明。简洁，不超过60字。",
          `转录内容：${transcript}`,
          { maxTokens: 100 }
        )
      : "没有听到明显的说话声";

    const caption = transcript
      ? `🎤 ${summary}\n原文：「${transcript}」`
      : "🎤 没有听到明显的说话声";

    // 清理 WAV，保留 MP3 供发送
    try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
    wavPath = null;

    return JSON.stringify({
      type: "file_attachment",
      filePath: mp3Path,
      caption,
      mimeType: "audio/mpeg",
    });
  } catch (error) {
    return `麦克风录音失败：${error.message}`;
  } finally {
    if (wavPath) try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
  }
}

export default run;
