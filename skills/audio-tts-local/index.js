/**
 * 音频TTS (文字转语音) Skill
 * 支持 OpenAI TTS 和 Google Cloud TTS
 */

import fs from 'fs';
import path from 'path';
import { commitMediaBudget, parseMediaInput, resolveMediaRoute } from '../_shared/media-router.js';
import { MediaError, ErrorCodes, fromLegacyError } from '../_shared/media-errors.js';
import { validateAudioTTSInput, validationErrorToMediaError } from '../_shared/media-validator.js';

function toStr(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function toNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(normalized);
}

/**
 * 安全路径生成
 */
function safePath(value, fallbackName) {
  const fallback = path.resolve(process.cwd(), 'sessions', 'media', 'audio', fallbackName);
  if (!value) {
    fs.mkdirSync(path.dirname(fallback), { recursive: true });
    return fallback;
  }
  const full = path.resolve(process.cwd(), toStr(value));
  const allowedRoots = [
    path.resolve(process.cwd(), 'sessions'),
    path.resolve(process.cwd(), 'assets'),
  ];
  const allowed = allowedRoots.some(root => full === root || full.startsWith(`${root}${path.sep}`));
  if (!allowed) {
    throw new MediaError(
      ErrorCodes.PATH_NOT_ALLOWED,
      `Path not allowed: ${value}`,
      { path: value, allowedRoots }
    );
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

/**
 * 构建OpenAI认证头
 */
function buildOpenAiAuthHeader() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new MediaError(
      ErrorCodes.MISSING_API_KEY,
      'OpenAI API key is required',
      { provider: 'openai', envVar: 'OPENAI_API_KEY' }
    );
  }
  const headerName = process.env.OPENAI_AUTH_HEADER || 'Authorization';
  const scheme = process.env.OPENAI_AUTH_SCHEME || 'Bearer';
  const value = headerName.toLowerCase() === 'authorization' ? `${scheme} ${key}`.trim() : key;
  return { headerName, value };
}

/**
 * 解析代理配置
 */
function resolveProxy(provider, payload) {
  const useProxy = toBool(
    payload?.[`${provider}_use_proxy`] ?? payload?.use_proxy ?? process.env[`${provider.toUpperCase()}_USE_PROXY`],
    true
  );
  if (!useProxy) return null;

  return (
    toStr(payload?.[`${provider}_proxy_url`]) ||
    toStr(payload?.proxy_url) ||
    toStr(process.env[`${provider.toUpperCase()}_PROXY_URL`]) ||
    toStr(process.env.HTTPS_PROXY) ||
    toStr(process.env.HTTP_PROXY) ||
    null
  );
}

/**
 * 使用可选代理的fetch
 */
async function fetchWithOptionalProxy(url, init, proxyUrl) {
  if (!proxyUrl) {
    return await fetch(url, init);
  }

  const { ProxyAgent } = await import('undici');
  const dispatcher = new ProxyAgent(proxyUrl);
  try {
    return await fetch(url, { ...init, dispatcher });
  } finally {
    await dispatcher.close();
  }
}

/**
 * OpenAI TTS调用
 */
async function callOpenAiTTS(route, payload, outputPath) {
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
  const endpoint = process.env.OPENAI_TTS_API_URL || `${baseUrl.replace(/\/+$/, '')}/v1/audio/speech`;
  const auth = buildOpenAiAuthHeader();

  const body = {
    model: route.model || 'tts-1',
    voice: toStr(payload.voice || 'alloy'),
    input: toStr(payload.text),
    response_format: toStr(payload.format || 'mp3'),
    speed: toNum(payload.speed, 1.0),
  };

  const timeoutMs = toNum(payload.timeout_ms || process.env.OPENAI_TTS_TIMEOUT_MS, 60000);
  const proxyUrl = resolveProxy('openai', payload);

  let response;
  try {
    response = await fetchWithOptionalProxy(
      endpoint,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [auth.headerName]: auth.value,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      },
      proxyUrl
    );
  } catch (error) {
    throw new MediaError(
      ErrorCodes.NETWORK_TIMEOUT,
      `OpenAI TTS request failed: ${error.message}`,
      { endpoint, timeoutMs, proxy: proxyUrl }
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new MediaError(
      ErrorCodes.API_ERROR,
      `OpenAI TTS failed: ${response.status}`,
      { status: response.status, error: errorText.slice(0, 500) }
    );
  }

  // 写入文件
  const buffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(buffer));

  return {
    provider: 'openai',
    model: body.model,
    voice: body.voice,
    outputPath,
    size: buffer.byteLength,
    format: body.response_format,
  };
}

/**
 * Google TTS调用 (使用Google Cloud TTS API)
 */
async function callGoogleTTS(route, payload, outputPath) {
  const apiKey = process.env.GOOGLE_CLOUD_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new MediaError(
      ErrorCodes.MISSING_API_KEY,
      'Google Cloud API key is required',
      { provider: 'google', envVars: ['GOOGLE_CLOUD_API_KEY', 'GEMINI_API_KEY'] }
    );
  }

  const endpoint = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`;

  // 解析语言和voice
  const language = toStr(payload.language || 'zh-CN');
  const voiceName = toStr(payload.voice || `${language}-Neural2-A`);

  const body = {
    input: { text: toStr(payload.text) },
    voice: {
      languageCode: language,
      name: voiceName,
    },
    audioConfig: {
      audioEncoding: toStr(payload.format || 'MP3').toUpperCase(),
      speakingRate: toNum(payload.speed, 1.0),
    },
  };

  const timeoutMs = toNum(payload.timeout_ms || process.env.GOOGLE_TTS_TIMEOUT_MS, 60000);
  const proxyUrl = resolveProxy('google', payload);

  let response;
  try {
    response = await fetchWithOptionalProxy(
      endpoint,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      },
      proxyUrl
    );
  } catch (error) {
    throw new MediaError(
      ErrorCodes.NETWORK_TIMEOUT,
      `Google TTS request failed: ${error.message}`,
      { endpoint: 'texttospeech.googleapis.com', timeoutMs }
    );
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new MediaError(
      ErrorCodes.API_ERROR,
      `Google TTS failed: ${response.status}`,
      { status: response.status, error: errorData }
    );
  }

  const data = await response.json();

  if (!data.audioContent) {
    throw new MediaError(
      ErrorCodes.INVALID_RESPONSE,
      'Google TTS response missing audioContent',
      { response: data }
    );
  }

  // 解码base64并写入文件
  const audioBuffer = Buffer.from(data.audioContent, 'base64');
  fs.writeFileSync(outputPath, audioBuffer);

  return {
    provider: 'google',
    voice: voiceName,
    outputPath,
    size: audioBuffer.length,
    format: payload.format || 'mp3',
  };
}

/**
 * 重试包装器
 */
async function runWithRetry(route, payload, outputPath, maxRetries, baseDelayMs) {
  const errors = [];
  for (let i = 0; i <= maxRetries; i += 1) {
    try {
      if (route.provider === 'openai') {
        return { result: await callOpenAiTTS(route, payload, outputPath), errors };
      }
      if (route.provider === 'google') {
        return { result: await callGoogleTTS(route, payload, outputPath), errors };
      }
      throw new MediaError(
        ErrorCodes.UNSUPPORTED_PROVIDER,
        `Unsupported provider: ${route.provider}`,
        { provider: route.provider, supported: ['openai', 'google'] }
      );
    } catch (error) {
      const mediaError = error instanceof MediaError ? error : fromLegacyError(error);
      errors.push(mediaError.toString());

      if (i >= maxRetries || !mediaError.shouldRetry()) {
        throw mediaError;
      }

      await new Promise(resolve => setTimeout(resolve, baseDelayMs * Math.max(1, i + 1)));
    }
  }
  throw new MediaError(ErrorCodes.GENERATION_FAILED, 'Unreachable code');
}

/**
 * 主入口函数
 */
export async function run(input) {
  try {
    const payload = parseMediaInput(input, 'audio-tts');

    // 输入验证
    const validation = validateAudioTTSInput(payload);
    if (!validation.valid) {
      const error = validationErrorToMediaError(validation);
      return JSON.stringify(error.toJSON(), null, 2);
    }

    // 注意: media-router还没有audio支持，这里先使用临时路由逻辑
    // TODO: 将audio添加到media-router.js
    const provider = toStr(payload.provider || 'openai');
    const route = {
      provider,
      model: payload.model || (provider === 'openai' ? 'tts-1' : 'google-tts'),
      quality: toStr(payload.quality || 'standard'),
      estimatedCostUsd: provider === 'openai' ? 0.015 : 0.004, // 每1000字符估算
    };

    // 生成输出路径
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const format = toStr(payload.format || 'mp3');
    const outputPath = safePath(
      payload.filename || payload.output_path,
      `${stamp}-${route.provider}.${format}`
    );

    // 重试配置
    const primaryRetries = Math.max(0, toNum(payload.primary_retries ?? process.env.MEDIA_PRIMARY_MAX_RETRIES, 1));
    const retryDelayMs = Math.max(100, toNum(payload.retry_delay_ms ?? process.env.MEDIA_RETRY_BACKOFF_MS, 1200));

    // 执行TTS
    const { result } = await runWithRetry(route, payload, outputPath, primaryRetries, retryDelayMs);

    // TODO: 集成预算系统
    // const usage = commitMediaBudget('audio-tts', route, { status: 'ok' });

    return JSON.stringify(
      {
        ok: true,
        task: 'audio-tts',
        route,
        result,
        // budgetUsageAfter: usage,
      },
      null,
      2
    );
  } catch (error) {
    const mediaError = error instanceof MediaError ? error : fromLegacyError(error);
    return JSON.stringify(mediaError.toJSON(), null, 2);
  }
}
