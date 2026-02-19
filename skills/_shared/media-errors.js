/**
 * 媒体功能结构化错误处理系统
 * 提供统一的错误分类、上下文和追踪能力
 */

/**
 * 错误代码枚举
 * 使用分段编号便于分类:
 * - 1xxx: 配置错误
 * - 2xxx: 输入验证错误
 * - 3xxx: 预算和限制错误
 * - 4xxx: 网络和API错误
 * - 5xxx: 业务逻辑错误
 */
export const ErrorCodes = {
  // 配置错误 (1xxx)
  MISSING_API_KEY: 1001,
  INVALID_CONFIG: 1002,
  MISSING_DEPENDENCY: 1003,
  INVALID_ENVIRONMENT: 1004,

  // 输入验证错误 (2xxx)
  MISSING_PROMPT: 2001,
  INVALID_INPUT: 2002,
  FILE_TOO_LARGE: 2003,
  INVALID_FILE_FORMAT: 2004,
  TOO_MANY_FILES: 2005,
  PROMPT_TOO_LONG: 2006,
  PROMPT_TOO_SHORT: 2007,
  INVALID_PARAMETER: 2008,
  MISSING_REQUIRED_FIELD: 2009,

  // 预算和限制错误 (3xxx)
  BUDGET_EXCEEDED: 3001,
  RATE_LIMIT: 3002,
  QUOTA_EXCEEDED: 3003,
  CONCURRENT_LIMIT: 3004,

  // 网络和API错误 (4xxx)
  NETWORK_TIMEOUT: 4001,
  PROXY_ERROR: 4002,
  API_ERROR: 4003,
  CONNECTION_FAILED: 4004,
  API_RATE_LIMIT: 4005,
  API_UNAUTHORIZED: 4006,
  API_NOT_FOUND: 4007,
  API_SERVER_ERROR: 4008,

  // 业务逻辑错误 (5xxx)
  CONTENT_POLICY: 5001,
  GENERATION_FAILED: 5002,
  PROCESSING_FAILED: 5003,
  INVALID_RESPONSE: 5004,
  UNSUPPORTED_PROVIDER: 5005,
  UNSUPPORTED_OPERATION: 5006,
  PATH_NOT_ALLOWED: 5007,
  FILE_NOT_FOUND: 5008,
};

/**
 * 错误严重程度
 */
export const ErrorSeverity = {
  LOW: 'low',           // 用户输入错误，可恢复
  MEDIUM: 'medium',     // 临时故障，可重试
  HIGH: 'high',         // 配置问题，需要修复
  CRITICAL: 'critical', // 系统故障，需要立即处理
};

/**
 * 错误类别
 */
export const ErrorCategory = {
  CONFIG: 'configuration',
  INPUT: 'input_validation',
  BUDGET: 'budget_limit',
  NETWORK: 'network',
  API: 'api',
  BUSINESS: 'business_logic',
};

/**
 * 获取错误代码的元数据
 */
export function getErrorMetadata(code) {
  const metadata = {
    [ErrorCodes.MISSING_API_KEY]: {
      category: ErrorCategory.CONFIG,
      severity: ErrorSeverity.CRITICAL,
      retriable: false,
      userMessage: 'API密钥未配置',
    },
    [ErrorCodes.INVALID_CONFIG]: {
      category: ErrorCategory.CONFIG,
      severity: ErrorSeverity.HIGH,
      retriable: false,
      userMessage: '配置无效',
    },
    [ErrorCodes.MISSING_PROMPT]: {
      category: ErrorCategory.INPUT,
      severity: ErrorSeverity.LOW,
      retriable: false,
      userMessage: '缺少必需的prompt参数',
    },
    [ErrorCodes.INVALID_INPUT]: {
      category: ErrorCategory.INPUT,
      severity: ErrorSeverity.LOW,
      retriable: false,
      userMessage: '输入参数无效',
    },
    [ErrorCodes.FILE_TOO_LARGE]: {
      category: ErrorCategory.INPUT,
      severity: ErrorSeverity.LOW,
      retriable: false,
      userMessage: '文件大小超过限制',
    },
    [ErrorCodes.TOO_MANY_FILES]: {
      category: ErrorCategory.INPUT,
      severity: ErrorSeverity.LOW,
      retriable: false,
      userMessage: '文件数量超过限制',
    },
    [ErrorCodes.BUDGET_EXCEEDED]: {
      category: ErrorCategory.BUDGET,
      severity: ErrorSeverity.MEDIUM,
      retriable: false,
      userMessage: '预算已超限',
    },
    [ErrorCodes.RATE_LIMIT]: {
      category: ErrorCategory.BUDGET,
      severity: ErrorSeverity.MEDIUM,
      retriable: true,
      userMessage: '请求频率超限，请稍后重试',
    },
    [ErrorCodes.NETWORK_TIMEOUT]: {
      category: ErrorCategory.NETWORK,
      severity: ErrorSeverity.MEDIUM,
      retriable: true,
      userMessage: '网络请求超时',
    },
    [ErrorCodes.PROXY_ERROR]: {
      category: ErrorCategory.NETWORK,
      severity: ErrorSeverity.HIGH,
      retriable: true,
      userMessage: '代理连接失败',
    },
    [ErrorCodes.API_ERROR]: {
      category: ErrorCategory.API,
      severity: ErrorSeverity.MEDIUM,
      retriable: true,
      userMessage: 'API调用失败',
    },
    [ErrorCodes.CONTENT_POLICY]: {
      category: ErrorCategory.BUSINESS,
      severity: ErrorSeverity.LOW,
      retriable: false,
      userMessage: '内容违反安全策略',
    },
    [ErrorCodes.GENERATION_FAILED]: {
      category: ErrorCategory.BUSINESS,
      severity: ErrorSeverity.MEDIUM,
      retriable: true,
      userMessage: '生成失败',
    },
    [ErrorCodes.PATH_NOT_ALLOWED]: {
      category: ErrorCategory.BUSINESS,
      severity: ErrorSeverity.LOW,
      retriable: false,
      userMessage: '文件路径不允许',
    },
  };

  return metadata[code] || {
    category: ErrorCategory.BUSINESS,
    severity: ErrorSeverity.MEDIUM,
    retriable: false,
    userMessage: '未知错误',
  };
}

/**
 * 媒体错误类
 * 扩展标准Error，添加结构化信息
 */
export class MediaError extends Error {
  /**
   * @param {number} code - 错误代码 (来自 ErrorCodes)
   * @param {string} message - 技术错误信息
   * @param {object} context - 错误上下文数据
   */
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
    this.context = context;
    this.timestamp = new Date().toISOString();

    // 获取错误元数据
    const metadata = getErrorMetadata(code);
    this.category = metadata.category;
    this.severity = metadata.severity;
    this.retriable = metadata.retriable;
    this.userMessage = metadata.userMessage;

    // 捕获堆栈跟踪
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * 转换为JSON格式
   */
  toJSON() {
    return {
      error: true,
      code: this.code,
      category: this.category,
      severity: this.severity,
      message: this.message,
      userMessage: this.userMessage,
      retriable: this.retriable,
      context: this.context,
      timestamp: this.timestamp,
    };
  }

  /**
   * 转换为字符串
   */
  toString() {
    return `[MediaError ${this.code}] ${this.message}`;
  }

  /**
   * 是否应该重试
   */
  shouldRetry() {
    return this.retriable;
  }
}

/**
 * 从旧格式错误创建MediaError
 */
export function fromLegacyError(error) {
  const errorStr = String(error);

  // 匹配常见错误模式
  if (errorStr.includes('missing_OPENAI_API_KEY')) {
    return new MediaError(
      ErrorCodes.MISSING_API_KEY,
      'OpenAI API key is required',
      { provider: 'openai', checked: ['OPENAI_API_KEY'] }
    );
  }

  if (errorStr.includes('missing_GEMINI_API_KEY')) {
    return new MediaError(
      ErrorCodes.MISSING_API_KEY,
      'Gemini API key is required',
      { provider: 'gemini', checked: ['GEMINI_API_KEY'] }
    );
  }

  if (errorStr.includes('missing_prompt')) {
    return new MediaError(
      ErrorCodes.MISSING_PROMPT,
      'Prompt is required',
      {}
    );
  }

  if (errorStr.includes('budget_exceeded')) {
    return new MediaError(
      ErrorCodes.BUDGET_EXCEEDED,
      'Daily budget limit exceeded',
      {}
    );
  }

  if (errorStr.includes('Path not allowed')) {
    return new MediaError(
      ErrorCodes.PATH_NOT_ALLOWED,
      'File path is not allowed',
      { path: errorStr.match(/Path not allowed: (.+)/)?.[1] }
    );
  }

  if (errorStr.includes('timeout')) {
    return new MediaError(
      ErrorCodes.NETWORK_TIMEOUT,
      'Request timeout',
      { original: errorStr }
    );
  }

  if (errorStr.includes('429') || errorStr.includes('rate limit')) {
    return new MediaError(
      ErrorCodes.RATE_LIMIT,
      'Rate limit exceeded',
      { original: errorStr }
    );
  }

  if (errorStr.includes('content_policy') || errorStr.includes('safety')) {
    return new MediaError(
      ErrorCodes.CONTENT_POLICY,
      'Content violates policy',
      { original: errorStr }
    );
  }

  // 默认通用错误
  return new MediaError(
    ErrorCodes.GENERATION_FAILED,
    errorStr,
    { original: errorStr }
  );
}

/**
 * 包装异步函数，自动转换错误
 */
export function wrapWithErrorHandling(fn) {
  return async function (...args) {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof MediaError) {
        throw error;
      }
      throw fromLegacyError(error);
    }
  };
}

/**
 * 错误日志记录器
 */
export class ErrorLogger {
  constructor(logPath = null) {
    this.logPath = logPath;
    this.errors = [];
  }

  /**
   * 记录错误
   */
  log(error) {
    const entry = {
      timestamp: new Date().toISOString(),
      code: error.code,
      category: error.category,
      severity: error.severity,
      message: error.message,
      context: error.context,
    };

    this.errors.push(entry);

    // 控制台输出
    if (error.severity === ErrorSeverity.CRITICAL || error.severity === ErrorSeverity.HIGH) {
      console.error(`[${error.severity.toUpperCase()}] ${error.toString()}`);
      if (error.context && Object.keys(error.context).length > 0) {
        console.error('Context:', error.context);
      }
    }

    // TODO: 写入文件或发送到监控系统
    return entry;
  }

  /**
   * 获取错误统计
   */
  getStats() {
    const byCategory = {};
    const bySeverity = {};
    const byCode = {};

    for (const err of this.errors) {
      byCategory[err.category] = (byCategory[err.category] || 0) + 1;
      bySeverity[err.severity] = (bySeverity[err.severity] || 0) + 1;
      byCode[err.code] = (byCode[err.code] || 0) + 1;
    }

    return {
      total: this.errors.length,
      byCategory,
      bySeverity,
      byCode,
    };
  }
}

// 全局错误日志记录器
export const globalErrorLogger = new ErrorLogger();
