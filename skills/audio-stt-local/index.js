/**
 * 音频STT (语音转文字) Skill
 * 支持 OpenAI Whisper 和 Google Speech-to-Text
 */

import fs from 'fs';
import path from 'path';
import { FormData, File } from 'undici';
import { commitMediaBudget, parseMediaInput } from '../_shared/media-router.js';
import { MediaError, ErrorCodes, fromLegacyError } from '../_shared/media-errors.js';
import { validateAudioSTTInput, validationErrorToMediaError } from '../_shared/media-validator.js';

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
 * OpenAI Whisper STT调用
 */
async function callOpenAiWhisper(route, payload) {
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
  const endpoint = process.env.OPENAI_STT_API_URL || `${baseUrl.replace(/\/+$/, '')}/v1/audio/transcriptions`;
  const auth = buildOpenAiAuthHeader();

  const filePath = path.resolve(toStr(payload.file));

  if (!fs.existsSync(filePath)) {
    throw new MediaError(
      ErrorCodes.FILE_NOT_FOUND,
      `Audio file not found: ${payload.file}`,
      { path: filePath }
    );
  }

  // 读取文件
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  // 构建FormData
  const formData = new FormData();
  formData.append('file', new File([fileBuffer], fileName));
  formData.append('model', route.model || 'whisper-1');

  const responseFormat = toStr(payload.response_format || 'json');
  formData.append('response_format', responseFormat);

  if (payload.language && payload.language !== 'auto') {
    formData.append('language', toStr(payload.language));
  }

  if (payload.prompt) {
    formData.append('prompt', toStr(payload.prompt));
  }

  if (payload.temperature !== undefined) {
    formData.append('temperature', String(toNum(payload.temperature, 0)));
  }

  const timeoutMs = toNum(payload.timeout_ms || process.env.OPENAI_STT_TIMEOUT_MS, 120000);
  const proxyUrl = resolveProxy('openai', payload);

  let response;
  try {
    response = await fetchWithOptionalProxy(
      endpoint,
      {
        method: 'POST',
        headers: {
          [auth.headerName]: auth.value,
        },
        body: formData,
        signal: AbortSignal.timeout(timeoutMs),
      },
      proxyUrl
    );
  } catch (error) {
    throw new MediaError(
      ErrorCodes.NETWORK_TIMEOUT,
      `OpenAI Whisper request failed: ${error.message}`,
      { endpoint, timeoutMs, proxy: proxyUrl }
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new MediaError(
      ErrorCodes.API_ERROR,
      `OpenAI Whisper failed: ${response.status}`,
      { status: response.status, error: errorText.slice(0, 500) }
    );
  }

  // 根据格式解析响应
  let result;
  if (responseFormat === 'json' || responseFormat === 'verbose_json') {
    result = await response.json();
  } else {
    result = { text: await response.text() };
  }

  return {
    provider: 'openai',
    model: route.model || 'whisper-1',
    file: fileName,
    size: fileBuffer.length,
    format: responseFormat,
    ...result,
  };
}

/**
 * Google Speech-to-Text调用
 */
async function callGoogleSTT(route, payload) {
  const apiKey = process.env.GOOGLE_CLOUD_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new MediaError(
      ErrorCodes.MISSING_API_KEY,
      'Google Cloud API key is required',
      { provider: 'google', envVars: ['GOOGLE_CLOUD_API_KEY', 'GEMINI_API_KEY'] }
    );
  }

  const endpoint = `https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(apiKey)}`;

  const filePath = path.resolve(toStr(payload.file));

  if (!fs.existsSync(filePath)) {
    throw new MediaError(
      ErrorCodes.FILE_NOT_FOUND,
      `Audio file not found: ${payload.file}`,
      { path: filePath }
    );
  }

  // 读取并编码文件
  const fileBuffer = fs.readFileSync(filePath);
  const audioContent = fileBuffer.toString('base64');

  // 推断音频编码
  const ext = path.extname(filePath).toLowerCase();
  const encodingMap = {
    '.mp3': 'MP3',
    '.wav': 'LINEAR16',
    '.flac': 'FLAC',
    '.ogg': 'OGG_OPUS',
    '.webm': 'WEBM_OPUS',
  };
  const encoding = encodingMap[ext] || 'MP3';

  const body = {
    config: {
      encoding,
      languageCode: toStr(payload.language || 'zh-CN'),
      enableAutomaticPunctuation: true,
    },
    audio: {
      content: audioContent,
    },
  };

  const timeoutMs = toNum(payload.timeout_ms || process.env.GOOGLE_STT_TIMEOUT_MS, 120000);
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
      `Google STT request failed: ${error.message}`,
      { endpoint: 'speech.googleapis.com', timeoutMs }
    );
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new MediaError(
      ErrorCodes.API_ERROR,
      `Google STT failed: ${response.status}`,
      { status: response.status, error: errorData }
    );
  }

  const data = await response.json();

  // 提取文本
  const results = data.results || [];
  const text = results
    .map(r => r.alternatives?.[0]?.transcript || '')
    .join(' ')
    .trim();

  return {
    provider: 'google',
    file: path.basename(filePath),
    size: fileBuffer.length,
    text,
    results: results.map(r => ({
      transcript: r.alternatives?.[0]?.transcript || '',
      confidence: r.alternatives?.[0]?.confidence || 0,
    })),
  };
}

/**
 * 重试包装器
 */
async function runWithRetry(route, payload, maxRetries, baseDelayMs) {
  const errors = [];
  for (let i = 0; i <= maxRetries; i += 1) {
    try {
      if (route.provider === 'openai') {
        return { result: await callOpenAiWhisper(route, payload), errors };
      }
      if (route.provider === 'google') {
        return { result: await callGoogleSTT(route, payload), errors };
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
    const payload = parseMediaInput(input, 'audio-stt');

    // 输入验证
    const validation = validateAudioSTTInput(payload);
    if (!validation.valid) {
      const error = validationErrorToMediaError(validation);
      return JSON.stringify(error.toJSON(), null, 2);
    }

    // 临时路由逻辑
    const provider = toStr(payload.provider || 'openai');
    const route = {
      provider,
      model: payload.model || (provider === 'openai' ? 'whisper-1' : 'google-stt'),
      estimatedCostUsd: provider === 'openai' ? 0.006 : 0.004, // 每分钟估算
    };

    // 重试配置
    const primaryRetries = Math.max(0, toNum(payload.primary_retries ?? process.env.MEDIA_PRIMARY_MAX_RETRIES, 1));
    const retryDelayMs = Math.max(100, toNum(payload.retry_delay_ms ?? process.env.MEDIA_RETRY_BACKOFF_MS, 1200));

    // 执行STT
    const { result } = await runWithRetry(route, payload, primaryRetries, retryDelayMs);

    // TODO: 集成预算系统
    // const usage = commitMediaBudget('audio-stt', route, { status: 'ok' });

    return JSON.stringify(
      {
        ok: true,
        task: 'audio-stt',
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
