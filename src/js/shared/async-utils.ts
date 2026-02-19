/**
 * 异步操作工具函数
 * 提供超时保护、错误隔离等安全机制
 */

/**
 * 带超时保护和错误隔离的Promise.all替代方案
 *
 * 使用Promise.allSettled确保单个失败不影响其他操作
 * 为每个promise添加超时保护
 *
 * @param promises Promise数组
 * @param timeoutMs 超时时间（毫秒），默认5秒
 * @returns PromiseSettledResult数组，区分成功和失败
 *
 * @example
 * const results = await safePromiseAll([
 *   fetchUser(),
 *   fetchPosts(),
 *   fetchComments()
 * ], 3000);
 *
 * const successes = results.filter(r => r.status === 'fulfilled');
 * const failures = results.filter(r => r.status === 'rejected');
 */
export async function safePromiseAll<T>(
  promises: Promise<T>[],
  timeoutMs: number = 5000
): Promise<PromiseSettledResult<T>[]> {
  const wrappedPromises = promises.map(p =>
    Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Operation timeout after ${timeoutMs}ms`)), timeoutMs)
      )
    ])
  );

  return Promise.allSettled(wrappedPromises);
}

/**
 * 带超时的单个Promise
 *
 * ⚠️ 重要：超时后原Promise仍会继续执行！
 *
 * 如果需要真正取消操作，请使用支持 AbortSignal 的版本，
 * 并确保被包装的操作支持 AbortSignal。
 *
 * @param promise 要执行的Promise
 * @param timeoutMs 超时时间（毫秒）
 * @param timeoutError 超时时的错误信息
 * @returns 原Promise的结果或超时错误
 *
 * @example
 * // 基础用法（注意：超时后原操作仍在执行）
 * const result = await withTimeout(fetchData(), 5000);
 *
 * // 支持取消的用法
 * const controller = new AbortController();
 * const result = await withTimeout(
 *   fetch(url, { signal: controller.signal }),
 *   5000,
 *   undefined,
 *   { signal: controller.signal, onTimeout: () => controller.abort() }
 * );
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError?: string,
  options?: {
    signal?: AbortSignal;
    onTimeout?: () => void;
  }
): Promise<T> {
  // P1-8修复：添加超时回调机制，允许清理资源
  let timeoutId: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(
      () => {
        // 调用超时回调（如取消操作、清理资源）
        if (options?.onTimeout) {
          try {
            options.onTimeout();
          } catch (error) {
            // 忽略回调错误，不影响超时处理
          }
        }

        reject(new Error(timeoutError || `Timeout after ${timeoutMs}ms`));
      },
      timeoutMs
    );
  });

  // 如果提供了 AbortSignal，监听取消事件
  if (options?.signal) {
    options.signal.addEventListener('abort', () => {
      if (timeoutId) clearTimeout(timeoutId);
    });
  }

  return Promise.race([
    promise.finally(() => {
      // Promise完成时清理timeout
      if (timeoutId) clearTimeout(timeoutId);
    }),
    timeoutPromise
  ]);
}

/**
 * 重试机制
 *
 * @param fn 要执行的函数
 * @param retries 重试次数
 * @param delayMs 重试间隔（毫秒）
 * @returns 函数执行结果
 */
export async function retry<T>(
  fn: () => Promise<T>,
  retries: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (i < retries) {
        // 等待后重试
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError || new Error('All retries failed');
}

/**
 * 批量执行操作，控制并发数
 *
 * @param items 待处理的项目数组
 * @param fn 处理函数
 * @param concurrency 并发数
 * @returns 处理结果数组
 */
export async function batchProcess<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number = 5
): Promise<R[]> {
  const results: R[] = new Array(items.length);

  const executing = new Set<Promise<void>>();

  for (let i = 0; i < items.length; i++) {
    const promise = fn(items[i], i).then(result => {
      results[i] = result;
      executing.delete(promise);
    });

    executing.add(promise);

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  // P0-1修复: 使用 Promise.allSettled 确保所有 Promise 完成，避免单个失败导致整体超时
  await Promise.allSettled(executing);
  return results;
}
