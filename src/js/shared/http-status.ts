/**
 * 错误码到 HTTP 状态码的映射
 */
import { ErrorCode } from "./errors.js";

export function errorCodeToHttpStatus(code: ErrorCode): number {
  const mapping: Record<string, number> = {
    // 系统错误 -> 500
    [ErrorCode.SYSTEM_INTERNAL]: 500,
    [ErrorCode.SYSTEM_CONFIG_INVALID]: 500,
    [ErrorCode.SYSTEM_RESOURCE_EXHAUSTED]: 503,
    [ErrorCode.SYSTEM_TIMEOUT]: 504,

    // 认证错误 -> 401/403/429
    [ErrorCode.AUTH_INVALID_TOKEN]: 401,
    [ErrorCode.AUTH_INSUFFICIENT_PERMISSION]: 403,
    [ErrorCode.AUTH_RATE_LIMITED]: 429,

    // 提供商错误 -> 502/503/504
    [ErrorCode.PROVIDER_UNAVAILABLE]: 503,
    [ErrorCode.PROVIDER_QUOTA_EXCEEDED]: 503,
    [ErrorCode.PROVIDER_TIMEOUT]: 504,
    [ErrorCode.PROVIDER_INVALID_RESPONSE]: 502,

    // 技能/意图错误 -> 400/404
    [ErrorCode.SKILL_NOT_FOUND]: 404,
    [ErrorCode.SKILL_EXECUTION_FAILED]: 500,
    [ErrorCode.SKILL_TIMEOUT]: 504,
    [ErrorCode.SKILL_DEPENDENCY_MISSING]: 500,
    [ErrorCode.INTENT_NO_DECISION]: 400,
    [ErrorCode.INTENT_LOW_CONFIDENCE]: 400,
    [ErrorCode.INTENT_MISSING_SLOTS]: 400,
    [ErrorCode.INTENT_PARSING_FAILED]: 400,

    // 记忆错误 -> 500
    [ErrorCode.MEMORY_WRITE_FAILED]: 500,
    [ErrorCode.MEMORY_READ_FAILED]: 500,
    [ErrorCode.MEMORY_CONFLICT_DETECTED]: 409,
    [ErrorCode.MEMORY_INDEX_CORRUPTED]: 500,
    [ErrorCode.MEMORY_OPERATION_FAILED]: 500,
    [ErrorCode.MEMORY_RETRIEVAL_FAILED]: 500,
    [ErrorCode.MEMORY_SAVE_FAILED]: 500,

    // 输入错误 -> 400
    [ErrorCode.INPUT_VALIDATION_FAILED]: 400,
    [ErrorCode.INPUT_TOO_LARGE]: 413,
    [ErrorCode.INPUT_UNSUPPORTED_FORMAT]: 415
  };

  return mapping[code] || 500;
}
