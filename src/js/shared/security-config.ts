/**
 * 系统安全配置
 * 统一管理所有安全相关的配置选项
 */

import type { SecurityConfig } from "../security/middleware.js";
import type { SandboxConfig } from "../security/sandbox.js";

export interface SystemSecurityConfig {
  middleware: SecurityConfig;
  sandbox: SandboxConfig;
  general: {
    enableSecurityHeaders: boolean;
    enableRequestLogging: boolean;
    enableFailureNotifications: boolean;
    maxSessionDuration: number;
  };
}

export function loadSecurityConfig(): SystemSecurityConfig {
  return {
    middleware: {
      rateLimit: {
        windowMs: Number(process.env.JPCLAW_RATE_LIMIT_WINDOW_MS || "900000"), // 15分钟
        maxRequests: Number(process.env.JPCLAW_RATE_LIMIT_MAX_REQUESTS || "100"),
        skipSuccessfulRequests: process.env.JPCLAW_RATE_LIMIT_SKIP_SUCCESS === "true"
      },
      auth: {
        adminToken: process.env.JPCLAW_ADMIN_TOKEN,
        apiKeys: process.env.JPCLAW_API_KEYS ? process.env.JPCLAW_API_KEYS.split(",") : [],
        allowedOrigins: process.env.JPCLAW_ALLOWED_ORIGINS ? process.env.JPCLAW_ALLOWED_ORIGINS.split(",") : ["*"]
      },
      resource: {
        maxRequestBodySize: Number(process.env.JPCLAW_MAX_REQUEST_BODY_SIZE || String(10 * 1024 * 1024)), // 10MB
        maxConcurrentRequests: Number(process.env.JPCLAW_MAX_CONCURRENT_REQUESTS || "100"),
        requestTimeoutMs: Number(process.env.JPCLAW_REQUEST_TIMEOUT_MS || "30000") // 30秒
      },
      headers: {
        enableCors: process.env.JPCLAW_ENABLE_CORS !== "false", // 默认启用
        enableContentSecurity: process.env.JPCLAW_ENABLE_CSP === "true"
      }
    },
    
    sandbox: {
      maxExecutionTimeMs: Number(process.env.JPCLAW_SANDBOX_MAX_EXECUTION_MS || "30000"), // 30秒
      maxMemoryMB: Number(process.env.JPCLAW_SANDBOX_MAX_MEMORY_MB || "256"), // 256MB
      maxCpuPercent: Number(process.env.JPCLAW_SANDBOX_MAX_CPU_PERCENT || "50"), // 50%
      allowedModules: process.env.JPCLAW_SANDBOX_ALLOWED_MODULES 
        ? process.env.JPCLAW_SANDBOX_ALLOWED_MODULES.split(",")
        : [
            "crypto", "util", "path", "url", "querystring", "stream",
            "zlib", "events", "buffer", "string_decoder", "punycode"
          ],
      allowedPaths: process.env.JPCLAW_SANDBOX_ALLOWED_PATHS
        ? process.env.JPCLAW_SANDBOX_ALLOWED_PATHS.split(",")
        : ["skills/", "sessions/", "tmp/"],
      networkAccess: process.env.JPCLAW_SANDBOX_NETWORK_ACCESS === "true",
      fileSystemAccess: (process.env.JPCLAW_SANDBOX_FS_ACCESS as "none" | "read-only" | "restricted") || "restricted",
      maxOutputSize: Number(process.env.JPCLAW_SANDBOX_MAX_OUTPUT_SIZE || String(10 * 1024 * 1024)) // 10MB
    },
    
    general: {
      enableSecurityHeaders: process.env.JPCLAW_ENABLE_SECURITY_HEADERS !== "false", // 默认启用
      enableRequestLogging: process.env.JPCLAW_ENABLE_REQUEST_LOGGING !== "false", // 默认启用
      enableFailureNotifications: process.env.JPCLAW_ENABLE_FAILURE_NOTIFICATIONS === "true",
      maxSessionDuration: Number(process.env.JPCLAW_MAX_SESSION_DURATION_MS || String(24 * 60 * 60 * 1000)) // 24小时
    }
  };
}

export function validateSecurityConfig(config: SystemSecurityConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // 验证速率限制配置
  if (config.middleware.rateLimit) {
    const { windowMs, maxRequests } = config.middleware.rateLimit;
    if (windowMs <= 0) errors.push("Rate limit window must be positive");
    if (maxRequests <= 0) errors.push("Rate limit max requests must be positive");
  }

  // 验证资源限制配置
  if (config.middleware.resource) {
    const { maxRequestBodySize, maxConcurrentRequests, requestTimeoutMs } = config.middleware.resource;
    if (maxRequestBodySize <= 0) errors.push("Max request body size must be positive");
    if (maxConcurrentRequests <= 0) errors.push("Max concurrent requests must be positive");
    if (requestTimeoutMs <= 0) errors.push("Request timeout must be positive");
  }

  // 验证沙箱配置
  const { maxExecutionTimeMs, maxMemoryMB, maxCpuPercent, maxOutputSize } = config.sandbox;
  if (maxExecutionTimeMs <= 0) errors.push("Sandbox execution timeout must be positive");
  if (maxMemoryMB <= 0) errors.push("Sandbox memory limit must be positive");
  if (maxCpuPercent <= 0 || maxCpuPercent > 100) errors.push("Sandbox CPU limit must be between 1-100");
  if (maxOutputSize <= 0) errors.push("Sandbox output size limit must be positive");

  // 验证会话持续时间
  if (config.general.maxSessionDuration <= 0) {
    errors.push("Max session duration must be positive");
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * 获取安全配置摘要（用于日志和监控）
 */
export function getSecurityConfigSummary(config: SystemSecurityConfig): Record<string, unknown> {
  return {
    rateLimit: {
      enabled: !!config.middleware.rateLimit,
      windowMinutes: config.middleware.rateLimit ? Math.round(config.middleware.rateLimit.windowMs / 60000) : 0,
      maxRequests: config.middleware.rateLimit?.maxRequests || 0
    },
    auth: {
      hasAdminToken: !!config.middleware.auth?.adminToken,
      apiKeyCount: config.middleware.auth?.apiKeys?.length || 0,
      corsEnabled: config.middleware.headers?.enableCors || false
    },
    resource: {
      maxBodyMB: config.middleware.resource ? Math.round(config.middleware.resource.maxRequestBodySize / 1024 / 1024) : 0,
      maxConcurrent: config.middleware.resource?.maxConcurrentRequests || 0,
      timeoutSeconds: config.middleware.resource ? Math.round(config.middleware.resource.requestTimeoutMs / 1000) : 0
    },
    sandbox: {
      maxExecutionSeconds: Math.round(config.sandbox.maxExecutionTimeMs / 1000),
      maxMemoryMB: config.sandbox.maxMemoryMB,
      networkAccess: config.sandbox.networkAccess,
      fileSystemAccess: config.sandbox.fileSystemAccess,
      allowedModuleCount: config.sandbox.allowedModules.length
    },
    general: {
      securityHeaders: config.general.enableSecurityHeaders,
      requestLogging: config.general.enableRequestLogging,
      failureNotifications: config.general.enableFailureNotifications,
      sessionHours: Math.round(config.general.maxSessionDuration / 60 / 60 / 1000)
    }
  };
}