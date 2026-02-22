/**
 * Mic Listen Skill
 *
 * 录制电脑麦克风 8 秒音频，通过 Whisper STT 转文字，
 * 让用户了解当前电脑前有谁在说话、在说什么。
 * 仅支持 macOS（ffmpeg + AVFoundation）。
 * 设备 [1] = MacBook Pro麦克风（内置）
 */

import fs from "node:fs";
import path from "node:path";
import { safeExec, ensureDir, BRAIN_DIR, callAnthropic } from "../_shared/proactive-utils.js";

const MIC_DIR = path.join(BRAIN_DIR, "mic");
const DURATION_SEC = 8;
const MIC_DEVICE = ":1"; // [1] MacBook Pro麦克风

const STT_BASE_URL = process.env.MININGLAMP_GATEWAY_BASE_URL || "https://llm-guard.mininglamp.com";
const STT_API_KEY  = process.env.MININGLAMP_GATEWAY_API_KEY || process.env.LLM_GATEWAY_API_KEY || "";
const STT_MODEL    = process.env.MININGLAMP_GATEWAY_STT_MODEL || "whisper-1";

export async function run(_input) {
  let wavPath = null;
  let mp3Path = null;

  try {
    ensureDir(MIC_DIR);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    wavPath = path.join(MIC_DIR, `mic-${timestamp}.wav`);
    mp3Path = path.join(MIC_DIR, `mic-${timestamp}.mp3`);

    // Step 1：录制麦克风音频
    await safeExec("/opt/homebrew/bin/ffmpeg", [
      "-f", "avfoundation",
      "-i", MIC_DEVICE,
      "-t", String(DURATION_SEC),
      "-ar", "16000",   // Whisper 推荐采样率
      "-ac", "1",       // 单声道
      "-y",
      wavPath,
    ], { timeout: 20_000 });

    if (!fs.existsSync(wavPath)) throw new Error("录音文件未生成");

    // Step 2：转 MP3（Whisper API 兼容格式）
    await safeExec("/opt/homebrew/bin/ffmpeg", [
      "-i", wavPath,
      "-codec:a", "libmp3lame",
      "-qscale:a", "5",
      "-y",
      mp3Path,
    ], { timeout: 10_000 });

    if (!fs.existsSync(mp3Path)) throw new Error("MP3 转换失败");

    // Step 3：Whisper STT 转录
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

    if (!transcript) {
      return JSON.stringify({ ok: true, transcript: "", summary: "没有听到明显的说话声" });
    }

    // Step 4：AI 简短解读（谁在说、说什么）
    const summary = await callAnthropic(
      "你是听音助手。根据下方语音转文字内容，用一句话描述：有人在说话，以及说的是什么。如果内容清晰直接复述；如果不清晰或噪音多则说明。简洁，不超过60字。",
      `转录内容：${transcript}`,
      { maxTokens: 100 }
    );

    return JSON.stringify({ ok: true, transcript, summary });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error.message });
  } finally {
    // 清理临时文件
    for (const p of [wavPath, mp3Path]) {
      if (p) try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  }
}

export default run;
