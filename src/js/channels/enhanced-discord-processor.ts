/**
 * 增强的Discord消息处理器
 * 解决性能瓶颈和架构问题
 */

import type { Message } from "discord.js";
import { log, logError } from "../shared/logger.js";
import { JPClawError, ErrorCode } from "../shared/errors.js";
import { metrics } from "../monitoring/metrics.js";
import { createTraceId } from "../shared/trace.js";
import type { ChatEngine } from "../core/engine.js";
import type { AgentRouterAdminApi } from "../agents/router.js";

// 任务队列接口
interface TaskQueue {
  add<T>(task: () => Promise<T>, priority?: number): Promise<T>;
  size(): number;
  clear(): void;
}

// 消息路由类型
export type MessageRoute = 
  | "agent_reply" 
  | "moltbook" 
  | "agent_admin" 
  | "downloads" 
  | "local_ops" 
  | "web_command" 
  | "weather" 
  | "search_intent" 
  | "social_stats";

// 处理器上下文
export interface ProcessorContext {
  message: Message;
  route: MessageRoute;
  rawText: string;
  traceId: string;
  userId: string;
  channelId: string;
}

// 处理器结果
export interface ProcessorResult {
  success: boolean;
  output: string;
  processingTime: number;
  cacheHit?: boolean;
  errors?: string[];
}

// 路由处理器接口
export interface RouteHandler {
  canHandle(route: MessageRoute): boolean;
  handle(context: ProcessorContext): Promise<ProcessorResult>;
  priority: number;
}

/**
 * 简单的内存任务队列实现
 */
export class MemoryTaskQueue implements TaskQueue {
  private tasks: Array<{
    task: () => Promise<any>;
    priority: number;
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }> = [];

  private processing = false;
  private maxConcurrency: number;
  private currentConcurrency = 0;

  constructor(maxConcurrency = 5) {
    this.maxConcurrency = maxConcurrency;
  }

  async add<T>(task: () => Promise<T>, priority = 0): Promise<T> {
    return new Promise((resolve, reject) => {
      this.tasks.push({ task, priority, resolve, reject });
      this.tasks.sort((a, b) => b.priority - a.priority); // 高优先级排前
      this.processNext();
    });
  }

  size(): number {
    return this.tasks.length;
  }

  clear(): void {
    this.tasks.length = 0;
  }

  private async processNext(): Promise<void> {
    if (this.currentConcurrency >= this.maxConcurrency || this.tasks.length === 0) {
      return;
    }

    const taskItem = this.tasks.shift();
    if (!taskItem) return;

    this.currentConcurrency++;
    
    try {
      const result = await taskItem.task();
      taskItem.resolve(result);
    } catch (error) {
      taskItem.reject(error);
    } finally {
      this.currentConcurrency--;
      setImmediate(() => this.processNext()); // 继续处理下一个任务
    }
  }
}

/**
 * 响应缓存管理器
 */
export class ResponseCacheManager {
  private cache = new Map<string, {
    response: string;
    timestamp: number;
    hits: number;
  }>();
  
  private readonly ttl = 5 * 60 * 1000; // 5分钟TTL
  private readonly maxSize = 1000;

  generateKey(userId: string, route: MessageRoute, input: string): string {
    // 对于某些路由，不使用缓存
    const noCacheRoutes: MessageRoute[] = ["local_ops", "downloads"];
    if (noCacheRoutes.includes(route)) return "";
    
    // 生成缓存键
    const normalizedInput = input.toLowerCase().trim().slice(0, 100);
    return `${userId}:${route}:${Buffer.from(normalizedInput).toString('base64').slice(0, 20)}`;
  }

  get(key: string): string | null {
    if (!key) return null;
    
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    // 检查TTL
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    entry.hits++;
    return entry.response;
  }

  set(key: string, response: string): void {
    if (!key || response.length > 10000) return; // 不缓存过长响应
    
    // 清理过期条目
    this.cleanup();
    
    // 限制缓存大小
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
    
    this.cache.set(key, {
      response,
      timestamp: Date.now(),
      hits: 0
    });
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key);
      }
    }
  }

  getStats() {
    return {
      size: this.cache.size,
      hitRate: this.calculateHitRate()
    };
  }

  private calculateHitRate(): number {
    let totalHits = 0;
    let totalRequests = 0;
    
    for (const entry of this.cache.values()) {
      totalHits += entry.hits;
      totalRequests += entry.hits + 1; // +1 for initial set
    }
    
    return totalRequests > 0 ? totalHits / totalRequests : 0;
  }
}

/**
 * 增强的Discord消息处理器
 */
export class EnhancedDiscordProcessor {
  private taskQueue: TaskQueue;
  private cache: ResponseCacheManager;
  private handlers = new Map<MessageRoute, RouteHandler>();
  private processing = new Set<string>(); // 防止重复处理
  
  private readonly dedupeWindow = 3000; // 3秒去重窗口
  private readonly fastAckDelay = 850; // 快速响应延迟

  constructor(
    private agent: ChatEngine,
    private adminApi?: AgentRouterAdminApi,
    options: {
      maxConcurrency?: number;
      enableCache?: boolean;
    } = {}
  ) {
    this.taskQueue = new MemoryTaskQueue(options.maxConcurrency || 5);
    this.cache = new ResponseCacheManager();
    this.registerDefaultHandlers();
  }

  /**
   * 处理Discord消息
   */
  async processMessage(message: Message, route: MessageRoute, rawText: string): Promise<void> {
    const traceId = createTraceId();
    const userId = message.author.id;
    const channelId = message.channelId;
    
    // 去重检查
    const dedupeKey = this.generateDedupeKey(userId, rawText, route);
    if (this.processing.has(dedupeKey)) {
      await message.reply("这条请求我正在处理中，马上给你结果🙂");
      return;
    }

    // 缓存检查
    const cacheKey = this.cache.generateKey(userId, route, rawText);
    const cachedResponse = this.cache.get(cacheKey);
    if (cachedResponse) {
      await this.sendResponse(message, cachedResponse, true);
      
      metrics.increment("discord.cache.hit", 1, {
        route,
        userId
      });
      
      return;
    }

    const context: ProcessorContext = {
      message,
      route,
      rawText,
      traceId,
      userId,
      channelId
    };

    // 添加到任务队列处理
    this.processing.add(dedupeKey);
    
    try {
      await this.taskQueue.add(async () => {
        await this.processWithFastAck(context, cacheKey);
      }, this.getRoutePriority(route));
    } finally {
      this.processing.delete(dedupeKey);
    }
  }

  /**
   * 带快速确认的处理
   */
  private async processWithFastAck(context: ProcessorContext, cacheKey: string): Promise<void> {
    const startTime = Date.now();
    let ackSent = false;
    
    // 快速确认定时器
    const ackTimer = setTimeout(async () => {
      if (!ackSent) {
        ackSent = true;
        try {
          await context.message.react('👍');
        } catch (error) {
          // Ignore reaction errors
        }
      }
    }, this.fastAckDelay);

    try {
      // 获取对应的处理器
      const handler = this.getHandler(context.route);
      if (!handler) {
        throw new JPClawError({
          code: ErrorCode.SKILL_NOT_FOUND,
          message: `No handler found for route: ${context.route}`
        });
      }

      // 处理消息
      const result = await handler.handle(context);
      
      clearTimeout(ackTimer);
      
      if (result.success) {
        // 缓存结果
        if (cacheKey && result.output) {
          this.cache.set(cacheKey, result.output);
        }
        
        await this.sendResponse(context.message, result.output, false);
        
        metrics.increment("discord.process.success", 1, {
          route: context.route,
          processingTime: result.processingTime.toString()
        });
      } else {
        await this.sendErrorResponse(context.message, result.errors || ["Processing failed"]);
        
        metrics.increment("discord.process.failure", 1, {
          route: context.route
        });
      }

    } catch (error) {
      clearTimeout(ackTimer);
      
      logError(new JPClawError({
        code: ErrorCode.SYSTEM_INTERNAL,
        message: "Discord message processing failed",
        cause: error instanceof Error ? error : undefined
      }));

      await this.sendErrorResponse(context.message, [
        error instanceof Error ? error.message : String(error)
      ]);
      
      metrics.increment("discord.process.error", 1, {
        route: context.route
      });
    }
  }

  /**
   * 发送响应
   */
  private async sendResponse(message: Message, content: string, fromCache: boolean): Promise<void> {
    try {
      // 分块发送长消息
      const chunks = this.splitMessage(content);
      
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const prefix = fromCache ? "🔄 " : "";
        const suffix = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : "";
        
        await message.reply(`${prefix}${chunk}${suffix}`);
      }
    } catch (error) {
      log("error", "Failed to send Discord response", {
        error: String(error),
        messageId: message.id
      });
    }
  }

  /**
   * 发送错误响应
   */
  private async sendErrorResponse(message: Message, errors: string[]): Promise<void> {
    const errorMsg = `❌ 处理失败：${errors.join("; ")}`;
    try {
      await message.reply(errorMsg);
    } catch (error) {
      log("error", "Failed to send Discord error response", {
        error: String(error),
        messageId: message.id
      });
    }
  }

  /**
   * 拆分长消息
   */
  private splitMessage(content: string, maxLength = 1900): string[] {
    if (content.length <= maxLength) {
      return [content];
    }

    const chunks: string[] = [];
    let current = "";
    const lines = content.split('\n');
    
    for (const line of lines) {
      if (current.length + line.length + 1 <= maxLength) {
        current += (current ? '\n' : '') + line;
      } else {
        if (current) {
          chunks.push(current);
          current = "";
        }
        
        // 如果单行太长，强制分割
        if (line.length > maxLength) {
          let remaining = line;
          while (remaining.length > maxLength) {
            chunks.push(remaining.slice(0, maxLength));
            remaining = remaining.slice(maxLength);
          }
          current = remaining;
        } else {
          current = line;
        }
      }
    }
    
    if (current) {
      chunks.push(current);
    }
    
    return chunks;
  }

  /**
   * 注册路由处理器
   */
  registerHandler(route: MessageRoute, handler: RouteHandler): void {
    this.handlers.set(route, handler);
  }

  /**
   * 获取处理器
   */
  private getHandler(route: MessageRoute): RouteHandler | null {
    return this.handlers.get(route) || null;
  }

  /**
   * 获取路由优先级
   */
  private getRoutePriority(route: MessageRoute): number {
    const priorities: Record<MessageRoute, number> = {
      agent_admin: 10,
      local_ops: 8,
      agent_reply: 5,
      web_command: 4,
      search_intent: 4,
      weather: 3,
      social_stats: 3,
      downloads: 2,
      moltbook: 1
    };
    
    return priorities[route] || 1;
  }

  /**
   * 生成去重键
   */
  private generateDedupeKey(userId: string, rawText: string, route: MessageRoute): string {
    const normalized = rawText.toLowerCase().trim();
    const isAgentReply = route === "agent_reply";
    const windowMs = isAgentReply ? 30000 : 300000; // 30s vs 5min
    const timeWindow = Math.floor(Date.now() / windowMs);
    return `${userId}::${timeWindow}::${normalized}`;
  }

  /**
   * 注册默认处理器
   */
  private registerDefaultHandlers(): void {
    // 这里可以注册默认的处理器
    // 实际实现中会将现有的路由逻辑重构为独立的处理器
  }

  /**
   * 获取处理器统计信息
   */
  getStats(): {
    queueSize: number;
    processingCount: number;
    cacheStats: any;
  } {
    return {
      queueSize: this.taskQueue.size(),
      processingCount: this.processing.size,
      cacheStats: this.cache.getStats()
    };
  }

  /**
   * 关闭处理器
   */
  async shutdown(): Promise<void> {
    this.taskQueue.clear();
    this.processing.clear();
    log("info", "Enhanced Discord processor shut down");
  }
}

// 示例：代理回复处理器
export class AgentReplyHandler implements RouteHandler {
  readonly priority = 5;

  constructor(private agent: ChatEngine) {}

  canHandle(route: MessageRoute): boolean {
    return route === "agent_reply";
  }

  async handle(context: ProcessorContext): Promise<ProcessorResult> {
    const startTime = Date.now();
    
    try {
      const output = await this.agent.reply(context.rawText, {
        userId: context.userId,
        userName: context.message.author.username,
        channelId: context.channelId,
        traceId: context.traceId
      });

      return {
        success: true,
        output,
        processingTime: Date.now() - startTime
      };
    } catch (error) {
      return {
        success: false,
        output: "",
        processingTime: Date.now() - startTime,
        errors: [error instanceof Error ? error.message : String(error)]
      };
    }
  }
}

// 导出工厂函数
export function createEnhancedDiscordProcessor(
  agent: ChatEngine,
  adminApi?: AgentRouterAdminApi,
  options?: any
): EnhancedDiscordProcessor {
  const processor = new EnhancedDiscordProcessor(agent, adminApi, options);
  
  // 注册默认处理器
  processor.registerHandler("agent_reply", new AgentReplyHandler(agent));
  
  return processor;
}