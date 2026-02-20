/**
 * 安全中间件系统
 * 提供访问控制、速率限制、资源保护等安全功能
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { log, logError } from "../shared/logger.js";
import { JPClawError, ErrorCode } from "../shared/errors.js";
import { metrics } from "../monitoring/metrics.js";

/**
 * 扩展的请求类型（支持中间件添加的自定义属性）
 */
interface ExtendedRequest extends IncomingMessage {
  traceId?: string;
  authenticated?: boolean;
  authToken?: string;
  method?: string;
  url?: string;
  path?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface SecurityConfig {
  rateLimit?: {
    windowMs: number;
    maxRequests: number;
    skipSuccessfulRequests?: boolean;
    /** Per-endpoint rate limits (endpoint path -> limit config) */
    perEndpoint?: Record<string, { windowMs?: number; maxRequests: number }>;
  };
  auth?: {
    adminToken?: string;
    apiKeys?: string[];
    allowedOrigins?: string[];
  };
  resource?: {
    maxRequestBodySize: number;
    maxConcurrentRequests: number;
    requestTimeoutMs: number;
  };
  headers?: {
    enableCors: boolean;
    enableContentSecurity: boolean;
  };
}

// 速率限制存储
class RateLimitStore {
  private store = new Map<string, { count: number; resetTime: number }>();
  private cleanupInterval: NodeJS.Timeout;
  // P1-NEW-6修复: 最大条目数限制，防止内存无限增长
  private readonly MAX_ENTRIES = 10000;

  constructor() {
    // 定期清理过期条目
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // 1分钟
    // 优化：允许进程优雅退出
    this.cleanupInterval.unref();
  }

  get(key: string, windowMs: number): { count: number; resetTime: number } {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || now > entry.resetTime) {
      // P1-NEW-6修复: 超过最大条目数时，先清理再添加
      if (this.store.size >= this.MAX_ENTRIES) {
        this.cleanup();
        // 如果清理后仍然超限，删除最旧的条目
        if (this.store.size >= this.MAX_ENTRIES) {
          const firstKey = this.store.keys().next().value;
          if (firstKey !== undefined) this.store.delete(firstKey);
        }
      }
      const newEntry = { count: 0, resetTime: now + windowMs };
      this.store.set(key, newEntry);
      return newEntry;
    }

    return entry;
  }

  increment(key: string): void {
    const entry = this.store.get(key);
    if (entry) {
      entry.count++;
    }
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.resetTime) {
        this.store.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.store.clear();
  }
}

// 并发请求跟踪
class ConcurrencyTracker {
  private activeRequests = new Set<string>();
  private maxConcurrent: number;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  acquire(requestId: string): boolean {
    if (this.activeRequests.size >= this.maxConcurrent) {
      return false;
    }
    this.activeRequests.add(requestId);
    return true;
  }

  release(requestId: string): void {
    this.activeRequests.delete(requestId);
  }

  getActiveCount(): number {
    return this.activeRequests.size;
  }

  destroy(): void {
    this.activeRequests.clear();
  }
}

export class SecurityManager {
  private static instance: SecurityManager;
  private config: SecurityConfig;
  private rateLimitStore = new RateLimitStore();
  private concurrencyTracker: ConcurrencyTracker;

  private constructor(config: SecurityConfig) {
    this.config = config;
    this.concurrencyTracker = new ConcurrencyTracker(
      config.resource?.maxConcurrentRequests || 100
    );
  }

  static getInstance(config?: SecurityConfig): SecurityManager {
    if (!SecurityManager.instance && config) {
      SecurityManager.instance = new SecurityManager(config);
    }
    return SecurityManager.instance;
  }

  /**
   * 优化：销毁实例（清理资源）
   */
  destroy(): void {
    this.rateLimitStore.destroy();
    this.concurrencyTracker.destroy();
    log("info", "security.manager.destroyed");
  }

  /**
   * 优化：销毁单例实例
   */
  static destroyInstance(): void {
    if (SecurityManager.instance) {
      SecurityManager.instance.destroy();
      SecurityManager.instance = undefined as unknown as SecurityManager;
    }
  }

  /**
   * 速率限制中间件
   * 支持全局限制和per-endpoint细粒度限制
   */
  rateLimitMiddleware() {
    return (req: ExtendedRequest, res: ServerResponse, next: () => void) => {
      if (!this.config.rateLimit) return next();

      const clientId = this.getClientIdentifier(req);
      const endpoint = req.url || "";

      // 优化：检查是否有per-endpoint限制
      let windowMs = this.config.rateLimit.windowMs;
      let maxRequests = this.config.rateLimit.maxRequests;
      let limitKey = `rate_limit:global:${clientId}`;

      if (this.config.rateLimit.perEndpoint) {
        // 查找最长匹配的endpoint配置
        for (const [path, config] of Object.entries(this.config.rateLimit.perEndpoint)) {
          if (endpoint.startsWith(path)) {
            windowMs = config.windowMs || windowMs;
            maxRequests = config.maxRequests;
            limitKey = `rate_limit:${path}:${clientId}`;
            break;
          }
        }
      }

      const { skipSuccessfulRequests } = this.config.rateLimit;

      try {
        const entry = this.rateLimitStore.get(limitKey, windowMs);

        // 检查是否超过限制
        if (entry.count >= maxRequests) {
          metrics.increment("security.rate_limit.blocked", 1, {
            client_id: this.hashClientId(clientId),
            path: req.path || req.url || ""
          });

          const error = new JPClawError({
            code: ErrorCode.AUTH_RATE_LIMITED,
            message: "Rate limit exceeded",
            context: { 
              limit: maxRequests,
              windowMs,
              resetTime: entry.resetTime 
            },
            traceId: req.traceId
          });

          res.writeHead(429, { 
            "Content-Type": "application/json",
            "Retry-After": Math.ceil((entry.resetTime - Date.now()) / 1000).toString()
          });
          res.end(JSON.stringify({
            error: error.userMessage,
            retryAfter: entry.resetTime
          }));
          return;
        }

        // 增加计数（如果不跳过成功请求，或者是中间件阶段）
        if (!skipSuccessfulRequests) {
          this.rateLimitStore.increment(limitKey);
        } else {
          // 监听响应结束，只对失败请求计数
          res.on('finish', () => {
            if (res.statusCode >= 400) {
              this.rateLimitStore.increment(limitKey);
            }
          });
        }

        // 添加速率限制头部
        res.setHeader('X-RateLimit-Limit', maxRequests.toString());
        res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - entry.count - 1).toString());
        res.setHeader('X-RateLimit-Reset', entry.resetTime.toString());

        next();
      } catch (error) {
        logError(new JPClawError({
          code: ErrorCode.SYSTEM_INTERNAL,
          message: "Rate limiting error",
          cause: error instanceof Error ? error : undefined,
          traceId: req.traceId
        }));
        next(); // 发生错误时允许请求继续
      }
    };
  }

  /**
   * 身份验证中间件
   */
  authMiddleware() {
    return (req: ExtendedRequest, res: ServerResponse, next: () => void) => {
      // 对于不需要认证的路由，直接通过
      if (this.isPublicRoute(req.url || "")) {
        return next();
      }

      try {
        const token = this.extractToken(req);
        
        if (!token) {
          const error = new JPClawError({
            code: ErrorCode.AUTH_INVALID_TOKEN,
            message: "Missing authentication token",
            traceId: req.traceId
          });

          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.userMessage }));
          return;
        }

        if (!this.validateToken(token)) {
          metrics.increment("security.auth.invalid_token", 1, {
            token_hash: this.hashToken(token)
          });

          const error = new JPClawError({
            code: ErrorCode.AUTH_INVALID_TOKEN,
            message: "Invalid authentication token",
            traceId: req.traceId
          });

          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.userMessage }));
          return;
        }

        // 记录成功认证
        metrics.increment("security.auth.success", 1);
        req.authenticated = true;
        req.authToken = token;

        next();
      } catch (error) {
        logError(new JPClawError({
          code: ErrorCode.SYSTEM_INTERNAL,
          message: "Authentication error",
          cause: error instanceof Error ? error : undefined,
          traceId: req.traceId
        }));
        
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Authentication system error" }));
      }
    };
  }

  /**
   * 资源保护中间件
   */
  resourceProtectionMiddleware() {
    return (req: ExtendedRequest, res: ServerResponse, next: () => void) => {
      const requestId = req.traceId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      try {
        // 并发控制
        if (!this.concurrencyTracker.acquire(requestId)) {
          metrics.increment("security.concurrency.rejected", 1);

          const error = new JPClawError({
            code: ErrorCode.SYSTEM_RESOURCE_EXHAUSTED,
            message: "Too many concurrent requests",
            context: { 
              activeRequests: this.concurrencyTracker.getActiveCount(),
              maxConcurrent: this.config.resource?.maxConcurrentRequests 
            },
            traceId: req.traceId
          });

          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.userMessage }));
          return;
        }

        // 请求完成后释放并发资源
        res.on('finish', () => {
          this.concurrencyTracker.release(requestId);
          metrics.gauge("security.concurrency.active", this.concurrencyTracker.getActiveCount());
        });

        // 请求超时控制
        const timeout = this.config.resource?.requestTimeoutMs || 30000;
        const timer = setTimeout(() => {
          if (!res.headersSent) {
            metrics.increment("security.timeout.requests", 1);
            
            res.writeHead(408, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Request timeout" }));
          }
        }, timeout);

        res.on('finish', () => clearTimeout(timer));

        // 请求体大小限制
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
          const maxSize = this.config.resource?.maxRequestBodySize || 10 * 1024 * 1024; // 10MB
          let bodySize = 0;

          req.on('data', (chunk: Buffer) => {
            bodySize += chunk.length;
            if (bodySize > maxSize) {
              metrics.increment("security.body_size.rejected", 1);
              
              if (!res.headersSent) {
                res.writeHead(413, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Request body too large" }));
              }
              req.destroy();
            }
          });
        }

        next();
      } catch (error) {
        this.concurrencyTracker.release(requestId);
        
        logError(new JPClawError({
          code: ErrorCode.SYSTEM_INTERNAL,
          message: "Resource protection error",
          cause: error instanceof Error ? error : undefined,
          traceId: req.traceId
        }));
        
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Security system error" }));
      }
    };
  }

  /**
   * 安全头部中间件
   */
  securityHeadersMiddleware() {
    return (req: ExtendedRequest, res: ServerResponse, next: () => void) => {
      // 基础安全头部
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

      // CORS 头部
      if (this.config.headers?.enableCors) {
        const originHeader = req.headers.origin;
        const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
        const allowedOrigins = this.config.auth?.allowedOrigins || ['*'];

        if (allowedOrigins.includes('*') || (origin && allowedOrigins.includes(origin))) {
          res.setHeader('Access-Control-Allow-Origin', origin || '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token, X-Trace-Id');
          res.setHeader('Access-Control-Allow-Credentials', 'true');
          res.setHeader('Access-Control-Max-Age', '86400'); // 24小时缓存预检请求
        } else if (origin) {
          // 优化：记录被拒绝的CORS请求（用于调试）
          metrics.increment("security.cors.rejected", 1, {
            origin: this.hashClientId(origin),
            path: req.url || ""
          });
          log("warn", "security.cors.origin_not_allowed", {
            origin,
            allowedOrigins,
            path: req.url
          });
        }
      }

      // CSP 头部
      if (this.config.headers?.enableContentSecurity) {
        res.setHeader('Content-Security-Policy', 
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
      }

      // 处理 OPTIONS 预检请求
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      next();
    };
  }

  private getClientIdentifier(req: ExtendedRequest): string {
    // 优先使用认证信息
    const auth = req.headers.authorization;
    if (auth) {
      const authValue = Array.isArray(auth) ? auth[0] : auth;
      return `auth:${createHash('sha256').update(authValue).digest('hex').slice(0, 16)}`;
    }

    // 使用 IP 地址
    const ip = req.headers['x-forwarded-for'] || 
               req.headers['x-real-ip'] ||
               req.connection?.remoteAddress ||
               req.socket?.remoteAddress ||
               'unknown';

    return `ip:${Array.isArray(ip) ? ip[0] : ip}`;
  }

  private hashClientId(clientId: string): string {
    return createHash('sha256').update(clientId).digest('hex').slice(0, 16);
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex').slice(0, 16);
  }

  private isPublicRoute(url: string): boolean {
    const publicRoutes = [
      '/health',
      '/metrics',
      '/skills',
      '/webhook/feishu',
      '/webhook/wecom',
      '/chat', // 允许CLI测试访问
      '/dashboard', // 本地运维面板（网关仅监听 localhost）
      '/benchmark', // Dashboard 需要读取 benchmark 报告
      '/api/status' // 运营 Dashboard 状态接口
    ];

    return publicRoutes.some(route => url?.startsWith(route));
  }

  private extractToken(req: ExtendedRequest): string | null {
    // 从 Authorization header 提取
    const authHeader = req.headers.authorization;
    const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (authValue && authValue.startsWith('Bearer ')) {
      return authValue.slice(7);
    }

    // 从自定义 header 提取
    const adminToken = req.headers['x-admin-token'];
    const tokenValue = Array.isArray(adminToken) ? adminToken[0] : adminToken;
    if (tokenValue) {
      return tokenValue;
    }

    return null;
  }

  private validateToken(token: string): boolean {
    if (!this.config.auth) return true;

    const { adminToken, apiKeys } = this.config.auth;

    // 验证管理员令牌
    if (adminToken && this.safeCompare(token, adminToken)) {
      return true;
    }

    // 验证 API 密钥
    if (apiKeys) {
      return apiKeys.some(key => this.safeCompare(token, key));
    }

    return false;
  }

  private safeCompare(a: string, b: string): boolean {
    try {
      const bufA = Buffer.from(a, 'utf8');
      const bufB = Buffer.from(b, 'utf8');
      
      if (bufA.length !== bufB.length) {
        return false;
      }

      return timingSafeEqual(bufA, bufB);
    } catch {
      return false;
    }
  }

  /**
   * 获取安全统计信息
   */
  getSecurityStats(): Record<string, unknown> {
    return {
      concurrency: {
        active: this.concurrencyTracker.getActiveCount(),
        max: this.config.resource?.maxConcurrentRequests || 100
      },
      rateLimit: {
        enabled: !!this.config.rateLimit,
        windowMs: this.config.rateLimit?.windowMs,
        maxRequests: this.config.rateLimit?.maxRequests
      },
      auth: {
        enabled: !!this.config.auth,
        hasAdminToken: !!this.config.auth?.adminToken,
        apiKeyCount: this.config.auth?.apiKeys?.length || 0
      }
    };
  }

}

/**
 * 创建安全中间件集合
 */
export function createSecurityMiddleware(config: SecurityConfig) {
  const security = SecurityManager.getInstance(config);

  return {
    rateLimit: security.rateLimitMiddleware(),
    auth: security.authMiddleware(),
    resourceProtection: security.resourceProtectionMiddleware(),
    securityHeaders: security.securityHeadersMiddleware(),
    getStats: () => security.getSecurityStats()
  };
}

/**
 * 优化：销毁安全管理器（用于优雅关闭）
 */
export function destroySecurity(): void {
  SecurityManager.destroyInstance();
}