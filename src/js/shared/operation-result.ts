/**
 * 统一返回值协议（阶段 2.1）
 *
 * 所有异步操作都应该返回 OperationResult<T>
 * 这样可以：
 * 1. 区分成功/失败
 * 2. 提供结构化的错误信息
 * 3. 明确是否可以重试
 * 4. 提供元数据（来源、耗时等）
 */

import { JPClawError, ErrorCode } from "./errors.js";

/**
 * 操作结果 - 成功分支
 */
export interface OperationSuccess<T> {
  ok: true;
  data: T;
  metadata?: {
    source?: "cache" | "computed" | "fallback";
    duration?: number;
    [key: string]: unknown;
  };
}

/**
 * 操作结果 - 失败分支
 */
export interface OperationFailure {
  ok: false;
  error: JPClawError;
  /** 是否可以重试（从 JPClawError 继承） */
  retryable: boolean;
  /** 重试延迟（毫秒） */
  retryAfterMs?: number;
}

/**
 * 统一操作结果类型
 */
export type OperationResult<T> = OperationSuccess<T> | OperationFailure;

/**
 * 辅助函数：创建成功结果
 */
export function createSuccess<T>(
  data: T,
  metadata?: OperationSuccess<T>["metadata"]
): OperationSuccess<T> {
  return {
    ok: true,
    data,
    ...(metadata && { metadata })
  };
}

/**
 * 辅助函数：创建失败结果
 */
export function createFailure(
  error: JPClawError,
  retryAfterMs?: number
): OperationFailure {
  return {
    ok: false,
    error,
    retryable: error.retryable,
    ...(retryAfterMs && { retryAfterMs })
  };
}

/**
 * 辅助函数：从错误码快速创建失败结果
 */
export function createFailureFromCode(
  code: ErrorCode,
  message: string,
  context?: Record<string, unknown>,
  retryAfterMs?: number
): OperationFailure {
  const error = new JPClawError({
    code,
    message,
    context
  });

  return createFailure(error, retryAfterMs);
}

/**
 * 辅助函数：包装 Promise，捕获异常并转换为 OperationResult
 */
export async function wrapPromise<T>(
  promise: Promise<T>,
  errorMapper?: (error: unknown) => JPClawError
): Promise<OperationResult<T>> {
  try {
    const data = await promise;
    return createSuccess(data);
  } catch (error) {
    const jpclawError = errorMapper
      ? errorMapper(error)
      : new JPClawError({
          code: ErrorCode.SYSTEM_INTERNAL,
          message: String(error),
          context: { originalError: error }
        });

    return createFailure(jpclawError);
  }
}

/**
 * 辅助函数：提取 OperationResult 的数据（如果成功）
 * 如果失败，抛出错误
 */
export function unwrap<T>(result: OperationResult<T>): T {
  if (result.ok) {
    return result.data;
  }

  throw result.error;
}

/**
 * 辅助函数：提取数据或返回默认值
 */
export function unwrapOr<T>(result: OperationResult<T>, defaultValue: T): T {
  return result.ok ? result.data : defaultValue;
}

/**
 * 辅助函数：映射成功值
 */
export function map<T, U>(
  result: OperationResult<T>,
  mapper: (data: T) => U
): OperationResult<U> {
  if (result.ok) {
    return createSuccess(mapper(result.data), result.metadata);
  }

  return result;
}

/**
 * 辅助函数：链式调用（flatMap）
 */
export async function andThen<T, U>(
  result: OperationResult<T>,
  mapper: (data: T) => Promise<OperationResult<U>>
): Promise<OperationResult<U>> {
  if (result.ok) {
    return await mapper(result.data);
  }

  return result;
}
