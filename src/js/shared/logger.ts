import type { JPClawError } from "./errors.js";
import { getCurrentTraceId } from "./trace.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const currentLevel: LogLevel = (process.env.JPCLAW_LOG_LEVEL as LogLevel) || "info";

export function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (levelOrder[level] < levelOrder[currentLevel]) return;

  // 阶段 5.4 修复：从 AsyncLocalStorage 获取 traceId（避免并发冲突）
  const traceId = meta?.traceId || getCurrentTraceId();

  const entry = {
    level,
    message,
    time: new Date().toISOString(),
    ...(traceId ? { traceId } : {}),
    ...meta
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * 专门用于记录 JPClawError 的日志函数
 */
export function logError(error: JPClawError, additionalContext?: Record<string, unknown>): void {
  const context = {
    errorCode: error.code,
    errorMessage: error.message,
    userMessage: error.userMessage,
    retryable: error.retryable,
    severity: getSeverity(error),
    traceId: error.traceId,
    stack: error.stack,
    ...error.context,
    ...additionalContext
  };

  log("error", `[${error.code}] ${error.message}`, context);

  // 如果是需要报警的错误，额外记录
  if (shouldAlert(error)) {
    log("error", `🚨 ALERT: Critical error detected`, {
      ...context,
      alert: true,
      urgency: "high"
    });
  }
}

/**
 * 记录性能指标
 */
export function logMetric(name: string, value: number, unit: string = "ms", tags?: Record<string, string>): void {
  log("info", `📊 METRIC: ${name}`, {
    metric: {
      name,
      value,
      unit,
      tags
    },
    timestamp: Date.now()
  });
}

/**
 * 记录链路追踪信息
 */
export function logTrace(operation: string, traceId: string, durationMs?: number, success: boolean = true, meta?: Record<string, unknown>): void {
  log("info", `🔍 TRACE: ${operation}`, {
    trace: {
      operation,
      traceId,
      durationMs,
      success
    },
    ...meta
  });
}

// 内部辅助函数
function getSeverity(error: JPClawError): "low" | "medium" | "high" | "critical" {
  if (error.code.startsWith("SYSTEM_") || error.code === "MEMORY_INDEX_CORRUPTED") {
    return "critical";
  }
  
  if (error.code.startsWith("PROVIDER_") || error.code.startsWith("AUTH_")) {
    return "high";
  }
  
  if (error.code.startsWith("SKILL_") || error.code.startsWith("MEMORY_")) {
    return "medium";
  }
  
  return "low";
}

function shouldAlert(error: JPClawError): boolean {
  const alertCodes = new Set([
    "SYSTEM_INTERNAL",
    "SYSTEM_CONFIG_INVALID", 
    "MEMORY_INDEX_CORRUPTED",
    "PROVIDER_QUOTA_EXCEEDED"
  ]);
  
  return alertCodes.has(error.code);
}
