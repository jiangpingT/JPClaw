/**
 * 输入验证工具
 * 提供安全的JSON解析和schema验证
 */

import type { IncomingMessage } from "node:http";
import { JPClawError, ErrorCode } from "./errors.js";
import { SECURITY_CONSTANTS } from "./constants.js";

/**
 * 验证器函数类型
 */
export type Validator<T> = (data: unknown) => { valid: true; data: T } | { valid: false; errors: string[] };

/**
 * 安全地解析JSON body
 *
 * @param req HTTP请求对象
 * @param maxSize 最大body大小（字节），默认10MB
 * @returns 解析后的对象
 */
export async function parseJsonBody<T = unknown>(
  req: IncomingMessage,
  maxSize: number = SECURITY_CONSTANTS.RESOURCE.DEFAULT_MAX_BODY_SIZE
): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;

      // 优化：立即检查大小，防止OOM
      if (size > maxSize) {
        req.destroy();
        reject(new JPClawError({
          code: ErrorCode.INPUT_VALIDATION_FAILED,
          message: "Request body too large",
          context: { size, maxSize }
        }));
        return;
      }

      body += chunk.toString("utf-8");
    });

    req.on("end", () => {
      try {
        // 优化：空body检查
        if (!body || body.trim() === "") {
          reject(new JPClawError({
            code: ErrorCode.INPUT_VALIDATION_FAILED,
            message: "Request body is empty"
          }));
          return;
        }

        const parsed = JSON.parse(body);

        // 优化：类型检查
        if (typeof parsed !== "object" || parsed === null) {
          reject(new JPClawError({
            code: ErrorCode.INPUT_VALIDATION_FAILED,
            message: "Request body must be a JSON object",
            context: { actualType: typeof parsed }
          }));
          return;
        }

        resolve(parsed as T);
      } catch (error) {
        if (error instanceof SyntaxError) {
          reject(new JPClawError({
            code: ErrorCode.INPUT_VALIDATION_FAILED,
            message: "Invalid JSON format",
            cause: error,
            context: {
              preview: body.slice(0, 100),
              position: error instanceof Error ? error.message : String(error)
            }
          }));
        } else {
          reject(error);
        }
      }
    });

    req.on("error", (error) => {
      reject(new JPClawError({
        code: ErrorCode.SYSTEM_INTERNAL,
        message: "Request stream error",
        cause: error instanceof Error ? error : undefined
      }));
    });
  });
}

/**
 * 创建字段验证器
 */
export function createFieldValidator<T extends Record<string, any>>(
  schema: {
    [K in keyof T]: {
      type: "string" | "number" | "boolean" | "array" | "object";
      required?: boolean;
      minLength?: number;
      maxLength?: number;
      pattern?: RegExp;
      min?: number;
      max?: number;
      items?: any;
    };
  }
): Validator<T> {
  return (data: unknown) => {
    const errors: string[] = [];

    if (typeof data !== "object" || data === null) {
      return { valid: false, errors: ["Data must be an object"] };
    }

    const obj = data as Record<string, any>;

    for (const [key, spec] of Object.entries(schema)) {
      const value = obj[key];

      // 必填检查
      if (spec.required && (value === undefined || value === null)) {
        errors.push(`Field '${key}' is required`);
        continue;
      }

      // 如果不是必填且为空，跳过后续检查
      if (!spec.required && (value === undefined || value === null)) {
        continue;
      }

      // 类型检查
      const actualType = Array.isArray(value) ? "array" : typeof value;
      if (actualType !== spec.type) {
        errors.push(`Field '${key}' must be ${spec.type}, got ${actualType}`);
        continue;
      }

      // 字符串验证
      if (spec.type === "string" && typeof value === "string") {
        if (spec.minLength !== undefined && value.length < spec.minLength) {
          errors.push(`Field '${key}' must be at least ${spec.minLength} characters`);
        }
        if (spec.maxLength !== undefined && value.length > spec.maxLength) {
          errors.push(`Field '${key}' must be at most ${spec.maxLength} characters`);
        }
        if (spec.pattern && !spec.pattern.test(value)) {
          errors.push(`Field '${key}' does not match required pattern`);
        }
      }

      // 数字验证
      if (spec.type === "number" && typeof value === "number") {
        if (spec.min !== undefined && value < spec.min) {
          errors.push(`Field '${key}' must be at least ${spec.min}`);
        }
        if (spec.max !== undefined && value > spec.max) {
          errors.push(`Field '${key}' must be at most ${spec.max}`);
        }
      }

      // 数组验证
      if (spec.type === "array" && Array.isArray(value)) {
        if (spec.minLength !== undefined && value.length < spec.minLength) {
          errors.push(`Field '${key}' must have at least ${spec.minLength} items`);
        }
        if (spec.maxLength !== undefined && value.length > spec.maxLength) {
          errors.push(`Field '${key}' must have at most ${spec.maxLength} items`);
        }
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true, data: obj as T };
  };
}

/**
 * 常用验证器
 */
export const commonValidators = {
  /**
   * Memory Query 验证器
   */
  memoryQuery: createFieldValidator<{
    text: string;
    userId: string;
    options?: Record<string, unknown>;
  }>({
    text: {
      type: "string",
      required: true,
      minLength: 1,
      maxLength: 10000
    },
    userId: {
      type: "string",
      required: true,
      minLength: 1,
      maxLength: 256
    },
    options: {
      type: "object",
      required: false
    }
  }),

  /**
   * Memory Update 验证器
   */
  memoryUpdate: createFieldValidator<{
    userId: string;
    input: string;
    options?: Record<string, unknown>;
  }>({
    userId: {
      type: "string",
      required: true,
      minLength: 1,
      maxLength: 256
    },
    input: {
      type: "string",
      required: true,
      minLength: 1,
      maxLength: 50000
    },
    options: {
      type: "object",
      required: false
    }
  }),

  /**
   * Chat 验证器
   */
  chat: createFieldValidator<{
    input: string;
    userId?: string;
    userName?: string;
    channelId?: string;
  }>({
    input: {
      type: "string",
      required: true,
      minLength: 1,
      maxLength: 10000
    },
    userId: {
      type: "string",
      required: false,
      maxLength: 256
    },
    userName: {
      type: "string",
      required: false,
      maxLength: 256
    },
    channelId: {
      type: "string",
      required: false,
      maxLength: 256
    }
  }),

  /**
   * Agent创建验证器
   */
  agentCreate: createFieldValidator<{
    id: string;
    name?: string;
  }>({
    id: {
      type: "string",
      required: true,
      minLength: 1,
      maxLength: 100,
      pattern: /^[a-zA-Z0-9_-]+$/
    },
    name: {
      type: "string",
      required: false,
      maxLength: 256
    }
  }),

  /**
   * Skill运行验证器
   */
  skillRun: createFieldValidator<{
    name: string;
    input?: string;
    scope?: "skills" | "agents";
  }>({
    name: {
      type: "string",
      required: true,
      minLength: 1,
      maxLength: 100
    },
    input: {
      type: "string",
      required: false,
      maxLength: 10000
    },
    scope: {
      type: "string",
      required: false
    }
  }),

  /**
   * Memory Cleanup验证器
   */
  memoryCleanup: createFieldValidator<{
    userId: string;
    options?: Record<string, unknown>;
  }>({
    userId: {
      type: "string",
      required: true,
      minLength: 1,
      maxLength: 256
    },
    options: {
      type: "object",
      required: false
    }
  }),

  /**
   * Memory Resolve Conflicts验证器
   */
  memoryResolveConflicts: createFieldValidator<{
    userId: string;
    conflictId?: string;
    strategy?: string;
  }>({
    userId: {
      type: "string",
      required: true,
      minLength: 1,
      maxLength: 256
    },
    conflictId: {
      type: "string",
      required: false,
      maxLength: 256
    },
    strategy: {
      type: "string",
      required: false,
      maxLength: 100
    }
  }),

  /**
   * Discord Channel Binding验证器
   */
  channelBinding: createFieldValidator<{
    channelId: string;
    agentId: string;
  }>({
    channelId: {
      type: "string",
      required: true,
      minLength: 1,
      maxLength: 256
    },
    agentId: {
      type: "string",
      required: true,
      minLength: 1,
      maxLength: 256
    }
  }),

  /**
   * Canvas Push验证器
   */
  canvasPush: createFieldValidator<{
    html?: string;
    type?: string;
  }>({
    html: {
      type: "string",
      required: false,
      maxLength: 1000000 // 1MB HTML content
    },
    type: {
      type: "string",
      required: false,
      maxLength: 50
    }
  })
};

/**
 * 验证并解析请求体
 *
 * @param req HTTP请求
 * @param validator 验证器函数
 * @returns 验证后的数据
 */
export async function validateAndParse<T>(
  req: IncomingMessage,
  validator: Validator<T>
): Promise<T> {
  // 1. 安全解析JSON
  const data = await parseJsonBody(req);

  // 2. 验证schema
  const result = validator(data);

  if (!result.valid) {
    throw new JPClawError({
      code: ErrorCode.INPUT_VALIDATION_FAILED,
      message: "Request validation failed",
      context: { errors: result.errors }
    });
  }

  return result.data;
}
