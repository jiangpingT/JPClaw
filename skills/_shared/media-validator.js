/**
 * 媒体功能输入验证系统
 * 提供统一的参数验证，防止无效输入导致API浪费
 */

import fs from 'fs';
import path from 'path';
import { MediaError, ErrorCodes } from './media-errors.js';

/**
 * 图片生成验证规则
 */
export const ImageValidationRules = {
  prompt: {
    required: true,
    minLength: 1,
    maxLength: 4000,
    // 防止XSS和注入
    dangerousPatterns: [/<script/i, /javascript:/i, /onerror=/i],
  },
  size: {
    allowed: [
      '256x256',
      '512x512',
      '1024x1024',
      '1024x1792',
      '1792x1024',
      '1792x1024',
    ],
  },
  resolution: {
    allowed: ['1K', '2K', '4K'],
  },
  quality: {
    allowed: ['standard', 'high'],
  },
  provider: {
    allowed: ['auto', 'openai', 'gemini'],
  },
  budget_mode: {
    allowed: ['free_first', 'quality_first'],
  },
  input_images: {
    maxCount: 14,
    maxSizeBytes: 20 * 1024 * 1024, // 20MB per image
    allowedFormats: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
  },
};

/**
 * 视频生成验证规则
 */
export const VideoValidationRules = {
  prompt: {
    required: true,
    minLength: 1,
    maxLength: 4000,
    dangerousPatterns: [/<script/i, /javascript:/i, /onerror=/i],
  },
  duration_seconds: {
    min: 2,
    max: 60,
  },
  aspect_ratio: {
    allowed: ['16:9', '9:16', '1:1', '4:3', '3:4'],
  },
  quality: {
    allowed: ['standard', 'high'],
  },
  provider: {
    allowed: ['auto', 'openai', 'gemini'],
  },
};

/**
 * 音频TTS验证规则
 */
export const AudioTTSValidationRules = {
  text: {
    required: true,
    minLength: 1,
    maxLength: 4096,
  },
  voice: {
    // OpenAI voices
    openai: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
    // Google voices (简化)
    google: ['en-US-Neural2-A', 'zh-CN-Neural2-A', 'ja-JP-Neural2-A'],
  },
  language: {
    allowed: ['zh', 'en', 'ja', 'es', 'fr', 'de'],
  },
  speed: {
    min: 0.25,
    max: 4.0,
  },
  format: {
    allowed: ['mp3', 'opus', 'aac', 'flac', 'wav'],
  },
};

/**
 * 音频STT验证规则
 */
export const AudioSTTValidationRules = {
  file: {
    required: true,
    maxSizeBytes: 25 * 1024 * 1024, // 25MB
    allowedFormats: ['.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm'],
  },
  language: {
    allowed: ['zh', 'en', 'ja', 'auto'],
  },
  response_format: {
    allowed: ['json', 'text', 'srt', 'verbose_json', 'vtt'],
  },
};

/**
 * 字幕提取验证规则
 */
export const TranscriptValidationRules = {
  url: {
    required: true,
    pattern: /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//,
  },
  maxSegments: {
    min: 1,
    max: 2000,
  },
  languages: {
    maxCount: 5,
  },
};

/**
 * 验证字符串字段
 */
function validateString(value, rules, fieldName) {
  const errors = [];

  if (rules.required && (!value || String(value).trim().length === 0)) {
    errors.push({
      field: fieldName,
      code: ErrorCodes.MISSING_REQUIRED_FIELD,
      message: `${fieldName} is required`,
    });
    return errors; // 如果必需但缺失，不继续验证
  }

  if (!value) return errors; // 非必需且为空，跳过验证

  const str = String(value);

  if (rules.minLength && str.length < rules.minLength) {
    errors.push({
      field: fieldName,
      code: ErrorCodes.PROMPT_TOO_SHORT,
      message: `${fieldName} must be at least ${rules.minLength} characters`,
      context: { actual: str.length, required: rules.minLength },
    });
  }

  if (rules.maxLength && str.length > rules.maxLength) {
    errors.push({
      field: fieldName,
      code: ErrorCodes.PROMPT_TOO_LONG,
      message: `${fieldName} must not exceed ${rules.maxLength} characters`,
      context: { actual: str.length, limit: rules.maxLength },
    });
  }

  if (rules.pattern && !rules.pattern.test(str)) {
    errors.push({
      field: fieldName,
      code: ErrorCodes.INVALID_INPUT,
      message: `${fieldName} does not match required pattern`,
    });
  }

  if (rules.dangerousPatterns) {
    for (const pattern of rules.dangerousPatterns) {
      if (pattern.test(str)) {
        errors.push({
          field: fieldName,
          code: ErrorCodes.INVALID_INPUT,
          message: `${fieldName} contains potentially dangerous content`,
        });
        break;
      }
    }
  }

  return errors;
}

/**
 * 验证枚举字段
 */
function validateEnum(value, allowedValues, fieldName) {
  if (!value) return [];

  const normalized = String(value).toLowerCase();

  if (!allowedValues.map(v => v.toLowerCase()).includes(normalized)) {
    return [{
      field: fieldName,
      code: ErrorCodes.INVALID_PARAMETER,
      message: `${fieldName} must be one of: ${allowedValues.join(', ')}`,
      context: { actual: value, allowed: allowedValues },
    }];
  }

  return [];
}

/**
 * 验证数值字段
 */
function validateNumber(value, rules, fieldName) {
  if (!value) return [];

  const num = Number(value);

  if (!Number.isFinite(num)) {
    return [{
      field: fieldName,
      code: ErrorCodes.INVALID_PARAMETER,
      message: `${fieldName} must be a valid number`,
    }];
  }

  const errors = [];

  if (rules.min !== undefined && num < rules.min) {
    errors.push({
      field: fieldName,
      code: ErrorCodes.INVALID_PARAMETER,
      message: `${fieldName} must be at least ${rules.min}`,
      context: { actual: num, min: rules.min },
    });
  }

  if (rules.max !== undefined && num > rules.max) {
    errors.push({
      field: fieldName,
      code: ErrorCodes.INVALID_PARAMETER,
      message: `${fieldName} must not exceed ${rules.max}`,
      context: { actual: num, max: rules.max },
    });
  }

  return errors;
}

/**
 * 验证文件
 */
function validateFile(filePath, rules, fieldName) {
  const errors = [];

  if (!filePath) {
    if (rules.required) {
      errors.push({
        field: fieldName,
        code: ErrorCodes.MISSING_REQUIRED_FIELD,
        message: `${fieldName} is required`,
      });
    }
    return errors;
  }

  const fullPath = path.resolve(filePath);

  // 检查文件是否存在
  if (!fs.existsSync(fullPath)) {
    errors.push({
      field: fieldName,
      code: ErrorCodes.FILE_NOT_FOUND,
      message: `File not found: ${filePath}`,
      context: { path: fullPath },
    });
    return errors;
  }

  // 检查文件格式
  const ext = path.extname(fullPath).toLowerCase();
  if (rules.allowedFormats && !rules.allowedFormats.includes(ext)) {
    errors.push({
      field: fieldName,
      code: ErrorCodes.INVALID_FILE_FORMAT,
      message: `File format ${ext} not allowed`,
      context: { format: ext, allowed: rules.allowedFormats },
    });
  }

  // 检查文件大小
  try {
    const stats = fs.statSync(fullPath);
    if (rules.maxSizeBytes && stats.size > rules.maxSizeBytes) {
      errors.push({
        field: fieldName,
        code: ErrorCodes.FILE_TOO_LARGE,
        message: `File size exceeds limit`,
        context: {
          size: stats.size,
          limit: rules.maxSizeBytes,
          sizeMB: (stats.size / 1024 / 1024).toFixed(2),
          limitMB: (rules.maxSizeBytes / 1024 / 1024).toFixed(2),
        },
      });
    }
  } catch (error) {
    errors.push({
      field: fieldName,
      code: ErrorCodes.INVALID_INPUT,
      message: `Cannot read file: ${error.message}`,
    });
  }

  return errors;
}

/**
 * 验证图片生成输入
 */
export function validateImageInput(payload) {
  const errors = [];

  // 验证prompt
  errors.push(...validateString(payload.prompt, ImageValidationRules.prompt, 'prompt'));

  // 验证size
  if (payload.size) {
    errors.push(...validateEnum(payload.size, ImageValidationRules.size.allowed, 'size'));
  }

  // 验证resolution
  if (payload.resolution) {
    errors.push(...validateEnum(payload.resolution, ImageValidationRules.resolution.allowed, 'resolution'));
  }

  // 验证quality
  if (payload.quality) {
    errors.push(...validateEnum(payload.quality, ImageValidationRules.quality.allowed, 'quality'));
  }

  // 验证provider
  if (payload.provider) {
    errors.push(...validateEnum(payload.provider, ImageValidationRules.provider.allowed, 'provider'));
  }

  // 验证budget_mode
  if (payload.budget_mode) {
    errors.push(...validateEnum(payload.budget_mode, ImageValidationRules.budget_mode.allowed, 'budget_mode'));
  }

  // 验证input_images
  if (payload.input_images) {
    if (!Array.isArray(payload.input_images)) {
      errors.push({
        field: 'input_images',
        code: ErrorCodes.INVALID_PARAMETER,
        message: 'input_images must be an array',
      });
    } else {
      if (payload.input_images.length > ImageValidationRules.input_images.maxCount) {
        errors.push({
          field: 'input_images',
          code: ErrorCodes.TOO_MANY_FILES,
          message: `Too many input images (${payload.input_images.length}). Maximum is ${ImageValidationRules.input_images.maxCount}`,
          context: {
            count: payload.input_images.length,
            max: ImageValidationRules.input_images.maxCount,
          },
        });
      }

      for (let i = 0; i < payload.input_images.length; i++) {
        errors.push(...validateFile(
          payload.input_images[i],
          ImageValidationRules.input_images,
          `input_images[${i}]`
        ));
      }
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/**
 * 验证视频生成输入
 */
export function validateVideoInput(payload) {
  const errors = [];

  errors.push(...validateString(payload.prompt, VideoValidationRules.prompt, 'prompt'));

  if (payload.duration_seconds) {
    errors.push(...validateNumber(
      payload.duration_seconds,
      VideoValidationRules.duration_seconds,
      'duration_seconds'
    ));
  }

  if (payload.aspect_ratio) {
    errors.push(...validateEnum(
      payload.aspect_ratio,
      VideoValidationRules.aspect_ratio.allowed,
      'aspect_ratio'
    ));
  }

  if (payload.quality) {
    errors.push(...validateEnum(payload.quality, VideoValidationRules.quality.allowed, 'quality'));
  }

  if (payload.provider) {
    errors.push(...validateEnum(payload.provider, VideoValidationRules.provider.allowed, 'provider'));
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/**
 * 验证音频TTS输入
 */
export function validateAudioTTSInput(payload) {
  const errors = [];

  errors.push(...validateString(payload.text, AudioTTSValidationRules.text, 'text'));

  if (payload.speed) {
    errors.push(...validateNumber(payload.speed, AudioTTSValidationRules.speed, 'speed'));
  }

  if (payload.format) {
    errors.push(...validateEnum(
      payload.format,
      AudioTTSValidationRules.format.allowed,
      'format'
    ));
  }

  if (payload.language) {
    errors.push(...validateEnum(
      payload.language,
      AudioTTSValidationRules.language.allowed,
      'language'
    ));
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/**
 * 验证音频STT输入
 */
export function validateAudioSTTInput(payload) {
  const errors = [];

  errors.push(...validateFile(payload.file, AudioSTTValidationRules.file, 'file'));

  if (payload.language) {
    errors.push(...validateEnum(
      payload.language,
      AudioSTTValidationRules.language.allowed,
      'language'
    ));
  }

  if (payload.response_format) {
    errors.push(...validateEnum(
      payload.response_format,
      AudioSTTValidationRules.response_format.allowed,
      'response_format'
    ));
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/**
 * 验证字幕提取输入
 */
export function validateTranscriptInput(payload) {
  const errors = [];

  errors.push(...validateString(payload.url, TranscriptValidationRules.url, 'url'));

  if (payload.maxSegments) {
    errors.push(...validateNumber(
      payload.maxSegments,
      TranscriptValidationRules.maxSegments,
      'maxSegments'
    ));
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/**
 * 从验证错误创建MediaError
 */
export function validationErrorToMediaError(validationResult) {
  if (validationResult.valid) {
    return null;
  }

  const firstError = validationResult.errors[0];

  return new MediaError(
    firstError.code,
    firstError.message,
    {
      field: firstError.field,
      allErrors: validationResult.errors,
      ...firstError.context,
    }
  );
}
