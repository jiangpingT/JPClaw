/**
 * 链路追踪系统
 * 用于追踪请求在系统中的完整流程
 */

import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { logTrace } from "./logger.js";

/**
 * 扩展的请求类型（支持中间件添加的自定义属性）
 */
interface ExtendedRequest extends IncomingMessage {
  span?: Span;
  traceId?: string;
  method?: string;
  url?: string;
}

/**
 * AsyncLocalStorage 用于存储 traceId（替代全局变量）
 * 解决并发请求时 traceId 混乱的问题
 */
const traceStorage = new AsyncLocalStorage<string>();

export type TraceContext = {
  traceId: string;
  parentSpanId?: string;
  operation: string;
  startTime: number;
  metadata?: Record<string, unknown>;
};

export class Span {
  public readonly traceId: string;
  public readonly spanId: string;
  public readonly parentSpanId?: string;
  public readonly operation: string;
  public readonly startTime: number;
  private endTime?: number;
  private metadata: Record<string, unknown> = {};
  private tags: Record<string, string> = {};
  private finished = false;

  constructor(traceId: string, operation: string, parentSpanId?: string) {
    this.traceId = traceId;
    this.spanId = generateSpanId();
    this.parentSpanId = parentSpanId;
    this.operation = operation;
    this.startTime = Date.now();
  }

  /**
   * 添加元数据
   */
  setMetadata(key: string, value: unknown): this {
    if (!this.finished) {
      this.metadata[key] = value;
    }
    return this;
  }

  /**
   * 添加标签
   */
  setTag(key: string, value: string): this {
    if (!this.finished) {
      this.tags[key] = value;
    }
    return this;
  }

  /**
   * 批量设置标签
   */
  setTags(tags: Record<string, string>): this {
    if (!this.finished) {
      Object.assign(this.tags, tags);
    }
    return this;
  }

  /**
   * 标记错误
   */
  setError(error: Error | string): this {
    if (!this.finished) {
      this.setTag("error", "true");
      this.setMetadata("error", {
        message: typeof error === "string" ? error : error.message,
        stack: typeof error === "string" ? undefined : error.stack
      });
    }
    return this;
  }

  /**
   * 完成 span
   */
  finish(success: boolean = true): void {
    if (this.finished) return;
    
    this.endTime = Date.now();
    this.finished = true;

    const duration = this.endTime - this.startTime;
    
    logTrace(this.operation, this.traceId, duration, success, {
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      tags: this.tags,
      metadata: this.metadata
    });
  }

  /**
   * 获取持续时间
   */
  getDuration(): number | undefined {
    if (!this.endTime) return undefined;
    return this.endTime - this.startTime;
  }

  /**
   * 创建子 span
   */
  createChild(operation: string): Span {
    return new Span(this.traceId, operation, this.spanId);
  }
}

export class Tracer {
  private static instance: Tracer;
  private currentSpan?: Span;

  private constructor() {}

  static getInstance(): Tracer {
    if (!Tracer.instance) {
      Tracer.instance = new Tracer();
    }
    return Tracer.instance;
  }

  /**
   * 开始一个新的 trace
   */
  startTrace(operation: string, traceId?: string): Span {
    const span = new Span(traceId || generateTraceId(), operation);
    this.currentSpan = span;
    return span;
  }

  /**
   * 从现有 trace 创建子 span
   */
  startSpan(operation: string, parentSpan?: Span): Span {
    const parent = parentSpan || this.currentSpan;
    if (!parent) {
      return this.startTrace(operation);
    }
    
    const span = parent.createChild(operation);
    this.currentSpan = span;
    return span;
  }

  /**
   * 获取当前活动的 span
   */
  getCurrentSpan(): Span | undefined {
    return this.currentSpan;
  }

  /**
   * 包装异步函数并自动追踪
   */
  async trace<T>(
    operation: string,
    fn: (span: Span) => Promise<T>,
    parentSpan?: Span
  ): Promise<T> {
    const span = this.startSpan(operation, parentSpan);
    const prevSpan = this.currentSpan;
    this.currentSpan = span;

    try {
      const result = await fn(span);
      span.finish(true);
      return result;
    } catch (error) {
      span.setError(error instanceof Error ? error : String(error));
      span.finish(false);
      throw error;
    } finally {
      this.currentSpan = prevSpan;
    }
  }

  /**
   * 包装同步函数并自动追踪
   */
  traceSync<T>(
    operation: string,
    fn: (span: Span) => T,
    parentSpan?: Span
  ): T {
    const span = this.startSpan(operation, parentSpan);
    const prevSpan = this.currentSpan;
    this.currentSpan = span;

    try {
      const result = fn(span);
      span.finish(true);
      return result;
    } catch (error) {
      span.setError(error instanceof Error ? error : String(error));
      span.finish(false);
      throw error;
    } finally {
      this.currentSpan = prevSpan;
    }
  }

  /**
   * 从 HTTP 头部提取或生成 trace ID
   */
  extractTraceFromHeaders(headers: Record<string, string | string[] | undefined>): string {
    // 尝试从标准 trace 头部提取
    const traceHeader = headers["x-trace-id"] || headers["traceparent"] || headers["x-request-id"];
    
    if (typeof traceHeader === "string" && traceHeader.length > 0) {
      return traceHeader.split("-")[0] || generateTraceId();
    }
    
    return generateTraceId();
  }
}

/**
 * 生成 trace ID
 */
function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * 创建唯一的追踪ID（别名）
 */
export function createTraceId(): string {
  return generateTraceId();
}

/**
 * 生成 span ID
 */
function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

// 导出全局实例
export const tracer = Tracer.getInstance();

/**
 * 装饰器：自动为类方法添加追踪
 */
export function traced(operation?: string) {
  return function (target: object, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const operationName = operation || `${(target as { constructor: { name: string } }).constructor.name}.${propertyKey}`;

    descriptor.value = async function (...args: unknown[]) {
      return tracer.trace(operationName, async (span) => {
        span.setTag("class", target.constructor.name);
        span.setTag("method", propertyKey);
        
        try {
          const result = await originalMethod.apply(this, args);
          span.setTag("success", "true");
          return result;
        } catch (error) {
          span.setTag("success", "false");
          throw error;
        }
      });
    };

    return descriptor;
  };
}

/**
 * 获取当前请求的 traceId（从 AsyncLocalStorage）
 * 修复：使用 AsyncLocalStorage 替代全局变量，避免并发冲突
 */
export function getCurrentTraceId(): string | undefined {
  return traceStorage.getStore();
}

/**
 * 中间件：为 HTTP 请求添加追踪
 */
export function createTracingMiddleware() {
  return function (req: ExtendedRequest, res: ServerResponse, next: () => void) {
    const traceId = tracer.extractTraceFromHeaders(req.headers);
    const span = tracer.startTrace(`HTTP ${req.method} ${req.url}`, traceId);

    span.setTags({
      "http.method": req.method || "",
      "http.url": req.url || "",
      "http.user_agent": req.headers["user-agent"] || "",
    });

    // 将 span 添加到请求上下文
    req.span = span;
    req.traceId = traceId;

    // 阶段 5.4：在响应头中返回 traceId
    res.setHeader("X-Trace-Id", traceId);

    // 监听响应结束
    res.on('finish', () => {
      span.setTag("http.status_code", res.statusCode.toString());
      span.setTag("success", res.statusCode < 400 ? "true" : "false");
      span.finish(res.statusCode < 400);
    });

    // 修复：使用 AsyncLocalStorage 存储 traceId，避免并发冲突
    traceStorage.run(traceId, () => {
      next();
    });
  };
}