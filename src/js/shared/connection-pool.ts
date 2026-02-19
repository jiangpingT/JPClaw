/**
 * 连接池管理器
 * 提供HTTP连接、WebSocket连接和数据库连接的池化管理
 */

import { EventEmitter } from "node:events";
import { log, logError } from "./logger.js";
import { JPClawError, ErrorCode } from "./errors.js";
import { metrics } from "../monitoring/metrics.js";

// 连接接口
export interface PooledConnection {
  id: string;
  isAlive(): boolean;
  reset(): Promise<void>;
  destroy(): Promise<void>;
  lastUsed: number;
  createdAt: number;
  useCount: number;
}

// 连接工厂接口
export interface ConnectionFactory<T extends PooledConnection> {
  create(): Promise<T>;
  validate(connection: T): Promise<boolean>;
  destroy(connection: T): Promise<void>;
}

// 连接池配置
export interface PoolConfig {
  minConnections: number;
  maxConnections: number;
  acquireTimeout: number;
  idleTimeout: number;
  maxLifetime: number;
  testInterval: number;
  maxRetries: number;
}

// 连接池统计
export interface PoolStats {
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  pendingRequests: number;
  totalCreated: number;
  totalDestroyed: number;
  totalAcquired: number;
  totalReleased: number;
  totalTimedOut: number;
  averageAcquireTime: number;
  averageUseTime: number;
}

/**
 * 通用连接池实现
 */
export class ConnectionPool<T extends PooledConnection> extends EventEmitter {
  private connections = new Set<T>();
  private available = new Set<T>();
  private pending: Array<{
    resolve: (connection: T) => void;
    reject: (error: Error) => void;
    timestamp: number;
  }> = [];

  private stats: PoolStats = {
    totalConnections: 0,
    activeConnections: 0,
    idleConnections: 0,
    pendingRequests: 0,
    totalCreated: 0,
    totalDestroyed: 0,
    totalAcquired: 0,
    totalReleased: 0,
    totalTimedOut: 0,
    averageAcquireTime: 0,
    averageUseTime: 0
  };

  private healthCheckTimer?: NodeJS.Timeout;
  private isClosing = false;
  private acquireTimes: number[] = [];
  private useTimes: number[] = [];

  constructor(
    private factory: ConnectionFactory<T>,
    private config: PoolConfig,
    private poolName: string = "unnamed"
  ) {
    super();
    this.startHealthCheck();
    this.preWarm();
  }

  /**
   * 获取连接
   */
  async acquire(): Promise<T> {
    if (this.isClosing) {
      throw new JPClawError({
        code: ErrorCode.SYSTEM_INTERNAL,
        message: "Connection pool is closing"
      });
    }

    const startTime = Date.now();
    
    return new Promise((resolve, reject) => {
      // 检查是否有可用连接
      const available = this.getAvailableConnection();
      if (available) {
        this.markAsAcquired(available);
        const acquireTime = Date.now() - startTime;
        this.recordAcquireTime(acquireTime);
        resolve(available);
        return;
      }

      // 检查是否可以创建新连接
      if (this.connections.size < this.config.maxConnections) {
        this.createConnection()
          .then(connection => {
            this.markAsAcquired(connection);
            const acquireTime = Date.now() - startTime;
            this.recordAcquireTime(acquireTime);
            resolve(connection);
          })
          .catch(reject);
        return;
      }

      // 加入等待队列
      const timeoutTimer = setTimeout(() => {
        const index = this.pending.findIndex(p => p.resolve === resolve);
        if (index !== -1) {
          this.pending.splice(index, 1);
          this.stats.pendingRequests--;
          this.stats.totalTimedOut++;
          reject(new JPClawError({
            code: ErrorCode.SYSTEM_TIMEOUT,
            message: `Connection acquire timeout after ${this.config.acquireTimeout}ms`
          }));
        }
      }, this.config.acquireTimeout);

      this.pending.push({
        resolve: (connection: T) => {
          clearTimeout(timeoutTimer);
          const acquireTime = Date.now() - startTime;
          this.recordAcquireTime(acquireTime);
          resolve(connection);
        },
        reject: (error: Error) => {
          clearTimeout(timeoutTimer);
          reject(error);
        },
        timestamp: Date.now()
      });
      
      this.stats.pendingRequests++;

      log("debug", "Connection queued", {
        poolName: this.poolName,
        queueSize: this.pending.length,
        totalConnections: this.connections.size
      });
    });
  }

  /**
   * 释放连接
   */
  async release(connection: T): Promise<void> {
    if (!this.connections.has(connection)) {
      log("warn", "Attempting to release unknown connection", {
        poolName: this.poolName,
        connectionId: connection.id
      });
      return;
    }

    const useTime = Date.now() - connection.lastUsed;
    this.recordUseTime(useTime);

    try {
      // 重置连接状态
      await connection.reset();
      
      // 检查连接是否仍然有效
      const isValid = await this.factory.validate(connection);
      if (!isValid || !connection.isAlive()) {
        await this.destroyConnection(connection);
        return;
      }

      // 标记为可用
      this.markAsAvailable(connection);
      this.stats.totalReleased++;

      // 处理等待队列
      this.processWaitingRequests();

      log("debug", "Connection released", {
        poolName: this.poolName,
        connectionId: connection.id,
        useTime
      });

    } catch (error) {
      log("warn", "Failed to reset connection, destroying it", {
        poolName: this.poolName,
        connectionId: connection.id,
        error: String(error)
      });
      
      await this.destroyConnection(connection);
    }
  }

  /**
   * 强制销毁连接
   */
  async destroy(connection: T): Promise<void> {
    await this.destroyConnection(connection);
  }

  /**
   * 获取池统计信息
   */
  getStats(): PoolStats {
    this.updateStats();
    return { ...this.stats };
  }

  /**
   * 关闭连接池
   */
  async close(): Promise<void> {
    this.isClosing = true;
    
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    // 拒绝所有等待的请求
    for (const pending of this.pending) {
      pending.reject(new JPClawError({
        code: ErrorCode.SYSTEM_INTERNAL,
        message: "Connection pool is closing"
      }));
    }
    this.pending.length = 0;

    // 销毁所有连接
    const destroyPromises = Array.from(this.connections).map(conn => 
      this.destroyConnection(conn)
    );
    
    await Promise.allSettled(destroyPromises);
    
    this.connections.clear();
    this.available.clear();
    
    log("info", "Connection pool closed", {
      poolName: this.poolName,
      finalStats: this.getStats()
    });
    
    this.emit('closed');
  }

  private getAvailableConnection(): T | null {
    for (const connection of this.available) {
      if (connection.isAlive()) {
        return connection;
      } else {
        // 异步销毁无效连接
        setImmediate(() => this.destroyConnection(connection));
      }
    }
    return null;
  }

  private markAsAcquired(connection: T): void {
    this.available.delete(connection);
    connection.lastUsed = Date.now();
    connection.useCount++;
    this.stats.totalAcquired++;
    this.updateStats();
  }

  private markAsAvailable(connection: T): void {
    this.available.add(connection);
    this.updateStats();
  }

  private async createConnection(): Promise<T> {
    try {
      const connection = await this.factory.create();
      connection.lastUsed = Date.now();
      
      this.connections.add(connection);
      this.stats.totalCreated++;
      
      log("debug", "Connection created", {
        poolName: this.poolName,
        connectionId: connection.id,
        totalConnections: this.connections.size
      });

      metrics.increment("connection_pool.created", 1, {
        pool: this.poolName
      });

      this.emit('connection-created', connection);
      return connection;
      
    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.SYSTEM_INTERNAL,
        message: `Failed to create connection in pool ${this.poolName}`,
        cause: error instanceof Error ? error : undefined
      }));
      
      throw error;
    }
  }

  private async destroyConnection(connection: T): Promise<void> {
    try {
      this.connections.delete(connection);
      this.available.delete(connection);
      
      await this.factory.destroy(connection);
      this.stats.totalDestroyed++;
      
      log("debug", "Connection destroyed", {
        poolName: this.poolName,
        connectionId: connection.id,
        totalConnections: this.connections.size
      });

      metrics.increment("connection_pool.destroyed", 1, {
        pool: this.poolName
      });

      this.emit('connection-destroyed', connection);
      
    } catch (error) {
      log("error", "Failed to destroy connection", {
        poolName: this.poolName,
        connectionId: connection.id,
        error: String(error)
      });
    }
  }

  private processWaitingRequests(): void {
    while (this.pending.length > 0 && this.available.size > 0) {
      const pending = this.pending.shift()!;
      const connection = this.getAvailableConnection();
      
      if (connection) {
        this.markAsAcquired(connection);
        this.stats.pendingRequests--;
        pending.resolve(connection);
      } else {
        // 没有可用连接，重新加入队列
        this.pending.unshift(pending);
        break;
      }
    }
  }

  private async preWarm(): Promise<void> {
    const promises: Promise<T>[] = [];
    
    for (let i = 0; i < this.config.minConnections; i++) {
      promises.push(this.createConnection());
    }
    
    try {
      const connections = await Promise.allSettled(promises);
      
      for (const result of connections) {
        if (result.status === 'fulfilled') {
          this.markAsAvailable(result.value);
        }
      }
      
      log("info", "Connection pool pre-warmed", {
        poolName: this.poolName,
        targetConnections: this.config.minConnections,
        actualConnections: this.connections.size
      });
      
    } catch (error) {
      log("error", "Failed to pre-warm connection pool", {
        poolName: this.poolName,
        error: String(error)
      });
    }
  }

  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(async () => {
      await this.performHealthCheck();
    }, this.config.testInterval);
  }

  private async performHealthCheck(): Promise<void> {
    const now = Date.now();
    const expiredConnections: T[] = [];
    const idleConnections: T[] = [];
    
    // 检查过期和空闲连接
    for (const connection of this.connections) {
      const age = now - connection.createdAt;
      const idle = now - connection.lastUsed;
      
      if (age > this.config.maxLifetime) {
        expiredConnections.push(connection);
      } else if (idle > this.config.idleTimeout && this.available.has(connection)) {
        idleConnections.push(connection);
      }
    }
    
    // 销毁过期连接
    for (const connection of expiredConnections) {
      await this.destroyConnection(connection);
    }
    
    // 销毁多余的空闲连接，但保持最小连接数
    const excessIdle = Math.max(0, 
      this.connections.size - this.config.minConnections
    );
    
    for (let i = 0; i < Math.min(excessIdle, idleConnections.length); i++) {
      await this.destroyConnection(idleConnections[i]);
    }
    
    // 确保最小连接数
    const deficit = this.config.minConnections - this.connections.size;
    if (deficit > 0) {
      for (let i = 0; i < deficit; i++) {
        try {
          const connection = await this.createConnection();
          this.markAsAvailable(connection);
        } catch (error) {
          log("error", "Failed to create connection during health check", {
            poolName: this.poolName,
            error: String(error)
          });
        }
      }
    }
    
    metrics.gauge("connection_pool.total", this.connections.size, {
      pool: this.poolName
    });
    
    metrics.gauge("connection_pool.available", this.available.size, {
      pool: this.poolName
    });
  }

  private updateStats(): void {
    this.stats.totalConnections = this.connections.size;
    this.stats.idleConnections = this.available.size;
    this.stats.activeConnections = this.connections.size - this.available.size;
    this.stats.averageAcquireTime = this.calculateAverage(this.acquireTimes);
    this.stats.averageUseTime = this.calculateAverage(this.useTimes);
  }

  private recordAcquireTime(time: number): void {
    this.acquireTimes.push(time);
    if (this.acquireTimes.length > 100) {
      this.acquireTimes.shift();
    }
  }

  private recordUseTime(time: number): void {
    this.useTimes.push(time);
    if (this.useTimes.length > 100) {
      this.useTimes.shift();
    }
  }

  private calculateAverage(numbers: number[]): number {
    if (numbers.length === 0) return 0;
    return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
  }
}

/**
 * HTTP连接包装器
 */
export class HttpConnection implements PooledConnection {
  public id: string;
  public lastUsed: number = Date.now();
  public createdAt: number = Date.now();
  public useCount: number = 0;

  constructor(public url: string, public options: any = {}) {
    this.id = `http_${Math.random().toString(36).slice(2)}`;
  }

  isAlive(): boolean {
    // HTTP连接是无状态的，总是可用
    return true;
  }

  async reset(): Promise<void> {
    // HTTP连接无需重置
  }

  async destroy(): Promise<void> {
    // HTTP连接无需显式销毁
  }
}

/**
 * HTTP连接工厂
 */
export class HttpConnectionFactory implements ConnectionFactory<HttpConnection> {
  constructor(private baseUrl: string, private defaultOptions: any = {}) {}

  async create(): Promise<HttpConnection> {
    return new HttpConnection(this.baseUrl, this.defaultOptions);
  }

  async validate(connection: HttpConnection): Promise<boolean> {
    return connection.isAlive();
  }

  async destroy(connection: HttpConnection): Promise<void> {
    await connection.destroy();
  }
}

/**
 * 连接池管理器
 */
export class ConnectionPoolManager {
  private static instance: ConnectionPoolManager;
  private pools = new Map<string, ConnectionPool<any>>();

  static getInstance(): ConnectionPoolManager {
    if (!ConnectionPoolManager.instance) {
      ConnectionPoolManager.instance = new ConnectionPoolManager();
    }
    return ConnectionPoolManager.instance;
  }

  createPool<T extends PooledConnection>(
    name: string,
    factory: ConnectionFactory<T>,
    config: Partial<PoolConfig> = {}
  ): ConnectionPool<T> {
    const fullConfig: PoolConfig = {
      minConnections: 2,
      maxConnections: 10,
      acquireTimeout: 10000,
      idleTimeout: 300000,
      maxLifetime: 3600000,
      testInterval: 30000,
      maxRetries: 3,
      ...config
    };

    const pool = new ConnectionPool(factory, fullConfig, name);
    this.pools.set(name, pool);
    
    return pool;
  }

  getPool<T extends PooledConnection>(name: string): ConnectionPool<T> | null {
    return this.pools.get(name) || null;
  }

  async closeAll(): Promise<void> {
    const closePromises = Array.from(this.pools.values()).map(pool => pool.close());
    await Promise.allSettled(closePromises);
    this.pools.clear();
  }

  getAllStats(): Record<string, PoolStats> {
    const stats: Record<string, PoolStats> = {};
    for (const [name, pool] of this.pools) {
      stats[name] = pool.getStats();
    }
    return stats;
  }
}

// 导出单例
export const connectionPoolManager = ConnectionPoolManager.getInstance();