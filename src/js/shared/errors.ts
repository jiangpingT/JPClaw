/**
 * 统一错误处理系统
 * 提供结构化的错误定义、分类和处理机制
 */

export enum ErrorCode {
  // 系统级错误 (1000-1999)
  SYSTEM_INTERNAL = "SYSTEM_INTERNAL",
  SYSTEM_CONFIG_INVALID = "SYSTEM_CONFIG_INVALID",
  SYSTEM_RESOURCE_EXHAUSTED = "SYSTEM_RESOURCE_EXHAUSTED",
  SYSTEM_TIMEOUT = "SYSTEM_TIMEOUT",
  
  // 认证授权错误 (2000-2999)
  AUTH_INVALID_TOKEN = "AUTH_INVALID_TOKEN",
  AUTH_INSUFFICIENT_PERMISSION = "AUTH_INSUFFICIENT_PERMISSION",
  AUTH_RATE_LIMITED = "AUTH_RATE_LIMITED",
  
  // 提供商错误 (3000-3999)
  PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE",
  PROVIDER_QUOTA_EXCEEDED = "PROVIDER_QUOTA_EXCEEDED",
  PROVIDER_TIMEOUT = "PROVIDER_TIMEOUT",
  PROVIDER_INVALID_RESPONSE = "PROVIDER_INVALID_RESPONSE",
  
  // 技能执行错误 (4000-4999)
  SKILL_NOT_FOUND = "SKILL_NOT_FOUND",
  SKILL_EXECUTION_FAILED = "SKILL_EXECUTION_FAILED",
  SKILL_TIMEOUT = "SKILL_TIMEOUT",
  SKILL_DEPENDENCY_MISSING = "SKILL_DEPENDENCY_MISSING",

  // 意图判定错误 (4100-4199)
  INTENT_NO_DECISION = "INTENT_NO_DECISION",
  INTENT_LOW_CONFIDENCE = "INTENT_LOW_CONFIDENCE",
  INTENT_MISSING_SLOTS = "INTENT_MISSING_SLOTS",
  INTENT_PARSING_FAILED = "INTENT_PARSING_FAILED",
  
  // 记忆系统错误 (5000-5999)
  MEMORY_WRITE_FAILED = "MEMORY_WRITE_FAILED",
  MEMORY_READ_FAILED = "MEMORY_READ_FAILED",
  MEMORY_CONFLICT_DETECTED = "MEMORY_CONFLICT_DETECTED",
  MEMORY_INDEX_CORRUPTED = "MEMORY_INDEX_CORRUPTED",
  MEMORY_OPERATION_FAILED = "MEMORY_OPERATION_FAILED",
  MEMORY_RETRIEVAL_FAILED = "MEMORY_RETRIEVAL_FAILED",
  MEMORY_SAVE_FAILED = "MEMORY_SAVE_FAILED",
  
  // 用户输入错误 (6000-6999)
  INPUT_VALIDATION_FAILED = "INPUT_VALIDATION_FAILED",
  INPUT_TOO_LARGE = "INPUT_TOO_LARGE",
  INPUT_UNSUPPORTED_FORMAT = "INPUT_UNSUPPORTED_FORMAT"
}

export class JPClawError extends Error {
  public readonly code: ErrorCode;
  public readonly context?: Record<string, unknown>;
  public readonly retryable: boolean;
  public readonly userMessage: string;
  public readonly timestamp: number;
  public readonly traceId?: string;

  constructor(options: {
    code: ErrorCode;
    message: string;
    userMessage?: string;
    context?: Record<string, unknown>;
    retryable?: boolean;
    traceId?: string;
    cause?: Error;
  }) {
    super(options.message);
    this.name = "JPClawError";
    this.code = options.code;
    this.userMessage = options.userMessage || this.getDefaultUserMessage(options.code);
    this.context = options.context;
    this.retryable = options.retryable ?? this.isRetryableByDefault(options.code);
    this.timestamp = Date.now();
    this.traceId = options.traceId;
    
    if (options.cause) {
      this.cause = options.cause;
    }
  }

  private getDefaultUserMessage(code: ErrorCode): string {
    const messages: Record<ErrorCode, string> = {
      [ErrorCode.SYSTEM_INTERNAL]: "系统内部错误，请稍后重试",
      [ErrorCode.SYSTEM_CONFIG_INVALID]: "系统配置错误，请联系管理员",
      [ErrorCode.SYSTEM_RESOURCE_EXHAUSTED]: "系统资源不足，请稍后重试",
      [ErrorCode.SYSTEM_TIMEOUT]: "系统操作超时，请稍后重试",
      
      [ErrorCode.AUTH_INVALID_TOKEN]: "身份验证失败，请检查权限",
      [ErrorCode.AUTH_INSUFFICIENT_PERMISSION]: "权限不足，无法执行此操作",
      [ErrorCode.AUTH_RATE_LIMITED]: "请求过于频繁，请稍后重试",
      
      [ErrorCode.PROVIDER_UNAVAILABLE]: "AI 服务暂时不可用，请稍后重试",
      [ErrorCode.PROVIDER_QUOTA_EXCEEDED]: "AI 服务配额已用完，请联系管理员",
      [ErrorCode.PROVIDER_TIMEOUT]: "AI 服务响应超时，请重试",
      [ErrorCode.PROVIDER_INVALID_RESPONSE]: "AI 服务响应异常，请重试",
      
      [ErrorCode.SKILL_NOT_FOUND]: "技能不存在，请检查技能名称",
      [ErrorCode.SKILL_EXECUTION_FAILED]: "技能执行失败，请检查输入参数",
      [ErrorCode.SKILL_TIMEOUT]: "技能执行超时，请简化任务或稍后重试",
      [ErrorCode.SKILL_DEPENDENCY_MISSING]: "技能依赖缺失，请安装相关依赖",

      [ErrorCode.INTENT_NO_DECISION]: "无法理解您的意图，请换个方式描述",
      [ErrorCode.INTENT_LOW_CONFIDENCE]: "不太确定您的意图，为了更好地帮您，我会用对话方式回复",
      [ErrorCode.INTENT_MISSING_SLOTS]: "需要更多信息才能继续",
      [ErrorCode.INTENT_PARSING_FAILED]: "意图解析失败，将用对话方式回复",
      
      [ErrorCode.MEMORY_WRITE_FAILED]: "记忆写入失败，信息可能未保存",
      [ErrorCode.MEMORY_READ_FAILED]: "记忆读取失败，可能影响个性化回复",
      [ErrorCode.MEMORY_CONFLICT_DETECTED]: "检测到记忆冲突，需要您确认",
      [ErrorCode.MEMORY_INDEX_CORRUPTED]: "记忆索引损坏，正在自动修复",
      [ErrorCode.MEMORY_OPERATION_FAILED]: "记忆操作失败，请重试",
      [ErrorCode.MEMORY_RETRIEVAL_FAILED]: "记忆检索失败，可能影响回复质量",
      [ErrorCode.MEMORY_SAVE_FAILED]: "记忆保存失败，信息可能丢失",
      
      [ErrorCode.INPUT_VALIDATION_FAILED]: "输入格式错误，请检查并重试",
      [ErrorCode.INPUT_TOO_LARGE]: "输入内容过大，请缩短后重试",
      [ErrorCode.INPUT_UNSUPPORTED_FORMAT]: "不支持的输入格式"
    };
    
    return messages[code] || "未知错误";
  }

  private isRetryableByDefault(code: ErrorCode): boolean {
    const retryableCodes = new Set([
      ErrorCode.SYSTEM_RESOURCE_EXHAUSTED,
      ErrorCode.PROVIDER_UNAVAILABLE,
      ErrorCode.PROVIDER_TIMEOUT,
      ErrorCode.SKILL_TIMEOUT,
      ErrorCode.MEMORY_READ_FAILED
    ]);
    
    return retryableCodes.has(code);
  }

  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      context: this.context,
      retryable: this.retryable,
      timestamp: this.timestamp,
      traceId: this.traceId,
      stack: this.stack
    };
  }
}

/**
 * 错误处理辅助函数
 */
export class ErrorHandler {
  /**
   * 包装异步函数，提供统一的错误处理
   */
  static async wrapAsync<T>(
    fn: () => Promise<T>,
    errorMapping?: {
      code: ErrorCode;
      userMessage?: string;
      context?: Record<string, unknown>;
      traceId?: string;
    }
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof JPClawError) {
        throw error;
      }
      
      throw new JPClawError({
        code: errorMapping?.code || ErrorCode.SYSTEM_INTERNAL,
        message: error instanceof Error ? error.message : String(error),
        userMessage: errorMapping?.userMessage,
        context: errorMapping?.context,
        traceId: errorMapping?.traceId,
        cause: error instanceof Error ? error : undefined
      });
    }
  }

  /**
   * 从 HTTP 状态码推断错误类型
   */
  static fromHttpStatus(status: number, message?: string, traceId?: string): JPClawError {
    let code: ErrorCode;
    
    if (status >= 400 && status < 500) {
      if (status === 401 || status === 403) {
        code = ErrorCode.AUTH_INVALID_TOKEN;
      } else if (status === 429) {
        code = ErrorCode.AUTH_RATE_LIMITED;
      } else {
        code = ErrorCode.INPUT_VALIDATION_FAILED;
      }
    } else if (status >= 500) {
      if (status === 503) {
        code = ErrorCode.PROVIDER_UNAVAILABLE;
      } else if (status === 504) {
        code = ErrorCode.PROVIDER_TIMEOUT;
      } else {
        code = ErrorCode.SYSTEM_INTERNAL;
      }
    } else {
      code = ErrorCode.SYSTEM_INTERNAL;
    }
    
    return new JPClawError({
      code,
      message: message || `HTTP ${status}`,
      context: { httpStatus: status },
      traceId
    });
  }

  /**
   * 判断错误是否需要立即报警
   */
  static shouldAlert(error: JPClawError): boolean {
    const alertCodes = new Set([
      ErrorCode.SYSTEM_INTERNAL,
      ErrorCode.SYSTEM_CONFIG_INVALID,
      ErrorCode.MEMORY_INDEX_CORRUPTED,
      ErrorCode.PROVIDER_QUOTA_EXCEEDED
    ]);
    
    return alertCodes.has(error.code);
  }

  /**
   * 获取错误的严重程度
   */
  static getSeverity(error: JPClawError): "low" | "medium" | "high" | "critical" {
    if (error.code.startsWith("SYSTEM_") || error.code === ErrorCode.MEMORY_INDEX_CORRUPTED) {
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
}

/**
 * 创建特定类型错误的便捷函数
 */
export const createError = {
  system: (message: string, context?: Record<string, unknown>, traceId?: string) =>
    new JPClawError({
      code: ErrorCode.SYSTEM_INTERNAL,
      message,
      context,
      traceId
    }),

  auth: (code: ErrorCode.AUTH_INVALID_TOKEN | ErrorCode.AUTH_INSUFFICIENT_PERMISSION | ErrorCode.AUTH_RATE_LIMITED, message: string, traceId?: string) =>
    new JPClawError({
      code,
      message,
      traceId
    }),

  provider: (code: ErrorCode.PROVIDER_UNAVAILABLE | ErrorCode.PROVIDER_QUOTA_EXCEEDED | ErrorCode.PROVIDER_TIMEOUT | ErrorCode.PROVIDER_INVALID_RESPONSE, message: string, context?: Record<string, unknown>, traceId?: string) =>
    new JPClawError({
      code,
      message,
      context,
      traceId
    }),

  skill: (code: ErrorCode.SKILL_NOT_FOUND | ErrorCode.SKILL_EXECUTION_FAILED | ErrorCode.SKILL_TIMEOUT | ErrorCode.SKILL_DEPENDENCY_MISSING, message: string, context?: Record<string, unknown>, traceId?: string) =>
    new JPClawError({
      code,
      message,
      context,
      traceId
    }),

  memory: (code: ErrorCode.MEMORY_WRITE_FAILED | ErrorCode.MEMORY_READ_FAILED | ErrorCode.MEMORY_CONFLICT_DETECTED | ErrorCode.MEMORY_INDEX_CORRUPTED, message: string, context?: Record<string, unknown>, traceId?: string) =>
    new JPClawError({
      code,
      message,
      context,
      traceId
    }),

  input: (code: ErrorCode.INPUT_VALIDATION_FAILED | ErrorCode.INPUT_TOO_LARGE | ErrorCode.INPUT_UNSUPPORTED_FORMAT, message: string, context?: Record<string, unknown>, traceId?: string) =>
    new JPClawError({
      code,
      message,
      context,
      traceId
    })
};