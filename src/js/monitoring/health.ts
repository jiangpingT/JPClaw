/**
 * 系统健康检查系统
 * 提供组件健康状态监控和诊断
 */

import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "../shared/logger.js";
import { metrics } from "./metrics.js";

export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface HealthCheck {
  name: string;
  description: string;
  check: () => Promise<HealthCheckResult>;
  timeout?: number;
  interval?: number;
  critical?: boolean;
}

export interface HealthCheckResult {
  status: HealthStatus;
  message?: string;
  details?: Record<string, unknown>;
  timestamp: number;
  duration: number;
}

export interface SystemHealth {
  overall: HealthStatus;
  timestamp: number;
  checks: Record<string, HealthCheckResult>;
  summary: {
    total: number;
    healthy: number;
    degraded: number;
    unhealthy: number;
    unknown: number;
  };
  uptime: number;
}

class HealthMonitor {
  private static instance: HealthMonitor;
  private checks = new Map<string, HealthCheck>();
  private lastResults = new Map<string, HealthCheckResult>();
  private intervals = new Map<string, NodeJS.Timeout>();
  private readonly startTime = Date.now();

  private constructor() {
    // 注册基础健康检查
    this.registerDefaultChecks();
  }

  static getInstance(): HealthMonitor {
    if (!HealthMonitor.instance) {
      HealthMonitor.instance = new HealthMonitor();
    }
    return HealthMonitor.instance;
  }

  /**
   * 注册健康检查
   */
  register(check: HealthCheck): void {
    this.checks.set(check.name, check);
    
    // 如果设置了间隔，启动定期检查
    if (check.interval && check.interval > 0) {
      this.startPeriodicCheck(check);
    }
    
    log("info", `Health check registered: ${check.name}`, {
      interval: check.interval,
      critical: check.critical
    });
  }

  /**
   * 取消注册健康检查
   */
  unregister(name: string): void {
    this.checks.delete(name);
    this.lastResults.delete(name);
    
    const interval = this.intervals.get(name);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(name);
    }
    
    log("info", `Health check unregistered: ${name}`);
  }

  /**
   * 执行单个健康检查
   */
  async runCheck(name: string): Promise<HealthCheckResult> {
    const check = this.checks.get(name);
    if (!check) {
      return {
        status: "unknown",
        message: `Health check '${name}' not found`,
        timestamp: Date.now(),
        duration: 0
      };
    }

    const startTime = Date.now();
    const timeout = check.timeout || 5000; // 默认5秒超时

    try {
      // 使用 Promise.race 实现超时控制
      const result = await Promise.race([
        check.check(),
        new Promise<HealthCheckResult>((_, reject) => {
          setTimeout(() => reject(new Error('Health check timeout')), timeout);
        })
      ]);

      result.timestamp = Date.now();
      result.duration = result.timestamp - startTime;

      this.lastResults.set(name, result);
      
      // 记录指标
      metrics.gauge(`health.check.${name}`, this.statusToNumber(result.status), {
        status: result.status
      });
      metrics.histogram(`health.check.${name}.duration`, result.duration);

      return result;
    } catch (error) {
      const result: HealthCheckResult = {
        status: "unhealthy",
        message: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
        duration: Date.now() - startTime,
        details: { error: String(error) }
      };

      this.lastResults.set(name, result);
      
      // 记录错误指标
      metrics.increment(`health.check.${name}.errors`, 1);
      metrics.gauge(`health.check.${name}`, this.statusToNumber(result.status), {
        status: result.status
      });

      log("warn", `Health check failed: ${name}`, {
        error: String(error),
        duration: result.duration
      });

      return result;
    }
  }

  /**
   * 执行所有健康检查
   */
  async runAllChecks(): Promise<SystemHealth> {
    const checkPromises = Array.from(this.checks.keys()).map(name => 
      this.runCheck(name).then(result => ({ name, result }))
    );

    const results = await Promise.allSettled(checkPromises);
    const checks: Record<string, HealthCheckResult> = {};
    
    let healthy = 0;
    let degraded = 0;
    let unhealthy = 0;
    let unknown = 0;

    for (const promiseResult of results) {
      if (promiseResult.status === 'fulfilled') {
        const { name, result } = promiseResult.value;
        checks[name] = result;
        
        switch (result.status) {
          case 'healthy': healthy++; break;
          case 'degraded': degraded++; break;
          case 'unhealthy': unhealthy++; break;
          case 'unknown': unknown++; break;
        }
      }
    }

    const total = healthy + degraded + unhealthy + unknown;
    
    // 计算整体健康状态
    const overall = this.calculateOverallHealth(checks);
    
    const systemHealth: SystemHealth = {
      overall,
      timestamp: Date.now(),
      checks,
      summary: { total, healthy, degraded, unhealthy, unknown },
      uptime: Date.now() - this.startTime
    };

    // 记录系统级指标
    metrics.gauge("health.overall", this.statusToNumber(overall));
    metrics.gauge("health.summary.healthy", healthy);
    metrics.gauge("health.summary.degraded", degraded);
    metrics.gauge("health.summary.unhealthy", unhealthy);

    return systemHealth;
  }

  /**
   * 获取最后的检查结果
   */
  getLastResult(name: string): HealthCheckResult | undefined {
    return this.lastResults.get(name);
  }

  /**
   * 获取所有检查的最后结果
   */
  getAllLastResults(): Record<string, HealthCheckResult> {
    const results: Record<string, HealthCheckResult> = {};
    for (const [name, result] of this.lastResults) {
      results[name] = result;
    }
    return results;
  }

  private startPeriodicCheck(check: HealthCheck): void {
    // 清理现有间隔
    const existingInterval = this.intervals.get(check.name);
    if (existingInterval) {
      clearInterval(existingInterval);
    }

    // 启动新的定期检查
    const interval = setInterval(async () => {
      try {
        await this.runCheck(check.name);
      } catch (error) {
        log("error", `Periodic health check error: ${check.name}`, {
          error: String(error)
        });
      }
    }, check.interval);

    this.intervals.set(check.name, interval);
  }

  private calculateOverallHealth(checks: Record<string, HealthCheckResult>): HealthStatus {
    const criticalChecks = Array.from(this.checks.values()).filter(c => c.critical);
    
    // 检查关键组件
    for (const criticalCheck of criticalChecks) {
      const result = checks[criticalCheck.name];
      if (result && result.status === 'unhealthy') {
        return 'unhealthy';
      }
    }

    // 计算非关键组件的健康度
    const statuses = Object.values(checks).map(r => r.status);
    const unhealthyCount = statuses.filter(s => s === 'unhealthy').length;
    const degradedCount = statuses.filter(s => s === 'degraded').length;
    const total = statuses.length;

    if (total === 0) return 'unknown';

    // 如果超过50%的服务不健康，系统不健康
    if (unhealthyCount / total > 0.5) {
      return 'unhealthy';
    }

    // 如果有任何不健康或降级的服务，系统降级
    if (unhealthyCount > 0 || degradedCount > 0) {
      return 'degraded';
    }

    return 'healthy';
  }

  private statusToNumber(status: HealthStatus): number {
    const mapping = {
      'healthy': 1,
      'degraded': 0.5,
      'unhealthy': 0,
      'unknown': -1
    };
    return mapping[status];
  }

  private registerDefaultChecks(): void {
    // 内存健康检查
    // 用 heapUsed 对比可配置上限（默认 512 MB），避免 heapUsed/heapTotal 产生假告警
    // heapTotal 是 Node.js 当前动态分配的堆大小，不是上限，用它做比值无实际意义
    this.register({
      name: "memory",
      description: "Check memory usage",
      check: async () => {
        const memUsage = process.memoryUsage();
        const heapMaxMB = Number(process.env.JPCLAW_HEAP_MAX_MB || 512);
        const heapUsedMB = memUsage.heapUsed / 1024 / 1024;
        const heapUsedPct = (heapUsedMB / heapMaxMB) * 100;

        const details = {
          heapUsedMB: Math.round(heapUsedMB),
          heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
          rssMB: Math.round(memUsage.rss / 1024 / 1024),
          heapMaxMB,
          heapUsedPct: Math.round(heapUsedPct),
        };

        if (heapUsedPct > 90) {
          return {
            status: "unhealthy",
            message: `堆内存严重不足：${Math.round(heapUsedMB)} MB / ${heapMaxMB} MB (${Math.round(heapUsedPct)}%)`,
            details,
            timestamp: Date.now(),
            duration: 0
          };
        } else if (heapUsedPct > 75) {
          return {
            status: "degraded",
            message: `堆内存偏高：${Math.round(heapUsedMB)} MB / ${heapMaxMB} MB (${Math.round(heapUsedPct)}%)`,
            details,
            timestamp: Date.now(),
            duration: 0
          };
        }

        return {
          status: "healthy",
          message: `堆内存正常：${Math.round(heapUsedMB)} MB / ${heapMaxMB} MB (${Math.round(heapUsedPct)}%)`,
          details,
          timestamp: Date.now(),
          duration: 0
        };
      },
      interval: 30000, // 30秒
      critical: true
    });

    // 系统 RAM 健康检查
    // macOS：使用 sysctl vm.memory_pressure（OS 级真实压力，含可回收 inactive 页）
    // os.freemem() 在 macOS 上接近 0 是正常现象（cache 占满），不能直接用作告警依据
    this.register({
      name: "system_memory",
      description: "Check system RAM pressure",
      check: async () => {
        const totalMB = Math.round(os.totalmem() / 1024 / 1024);
        const freeMB  = Math.round(os.freemem()  / 1024 / 1024);

        if (process.platform === "darwin") {
          try {
            const pressure = await new Promise<number>((resolve, reject) => {
              exec("sysctl -n vm.memory_pressure", { timeout: 2000 }, (err, stdout) => {
                if (err) reject(err);
                else resolve(Number(stdout.trim()));
              });
            });

            const details = { totalMB, freeMB, pressure };

            if (pressure >= 2) {
              return {
                status: "unhealthy" as const,
                message: `系统内存压力严重（pressure=${pressure}），OS 正在强制回收内存`,
                details,
                timestamp: Date.now(),
                duration: 0
              };
            }
            if (pressure === 1) {
              return {
                status: "degraded" as const,
                message: `系统内存压力偏高（pressure=${pressure}），OS 已开始主动回收`,
                details,
                timestamp: Date.now(),
                duration: 0
              };
            }
            return {
              status: "healthy" as const,
              message: `系统内存正常（pressure=0）`,
              details,
              timestamp: Date.now(),
              duration: 0
            };
          } catch {
            // sysctl 失败，降级用 freemem 比例
          }
        }

        // 非 macOS 或 sysctl 失败：用 freemem 比例（Linux 上有效）
        const freePct = Math.round((freeMB / totalMB) * 100);
        const details = { totalMB, freeMB, usedMB: totalMB - freeMB, freePct };

        if (freePct < 10) {
          return {
            status: "unhealthy" as const,
            message: `系统内存严重不足：剩余 ${freeMB} MB / ${totalMB} MB（${freePct}% 空闲）`,
            details,
            timestamp: Date.now(),
            duration: 0
          };
        }
        if (freePct < 15) {
          return {
            status: "degraded" as const,
            message: `系统内存偏低：剩余 ${freeMB} MB / ${totalMB} MB（${freePct}% 空闲）`,
            details,
            timestamp: Date.now(),
            duration: 0
          };
        }
        return {
          status: "healthy" as const,
          message: `系统内存正常：剩余 ${freeMB} MB / ${totalMB} MB（${freePct}% 空闲）`,
          details,
          timestamp: Date.now(),
          duration: 0
        };
      },
      interval: 30000,
      critical: false  // 系统整体内存压力，仅参考，不影响 overall 状态
    });

    // 磁盘健康检查
    this.register({
      name: "disk",
      description: "Check disk space",
      check: async () => {
        try {
          const statsPath = path.resolve(process.cwd());
          const stats = fs.statSync(statsPath);
          
          return {
            status: "healthy",
            message: "Disk access normal",
            details: { path: statsPath },
            timestamp: Date.now(),
            duration: 0
          };
        } catch (error) {
          return {
            status: "unhealthy",
            message: "Disk access failed",
            details: { error: String(error) },
            timestamp: Date.now(),
            duration: 0
          };
        }
      },
      interval: 60000, // 1分钟
      critical: true
    });

    // 事件循环健康检查
    this.register({
      name: "event_loop",
      description: "Check event loop lag",
      check: async () => {
        return new Promise((resolve) => {
          const start = process.hrtime.bigint();
          setImmediate(() => {
            const lag = Number(process.hrtime.bigint() - start) / 1000000; // ms
            
            if (lag > 100) {
              resolve({
                status: "unhealthy",
                message: `High event loop lag: ${lag.toFixed(2)}ms`,
                details: { lag },
                timestamp: Date.now(),
                duration: lag
              });
            } else if (lag > 50) {
              resolve({
                status: "degraded", 
                message: `Elevated event loop lag: ${lag.toFixed(2)}ms`,
                details: { lag },
                timestamp: Date.now(),
                duration: lag
              });
            } else {
              resolve({
                status: "healthy",
                message: `Event loop lag normal: ${lag.toFixed(2)}ms`,
                details: { lag },
                timestamp: Date.now(),
                duration: lag
              });
            }
          });
        });
      },
      interval: 15000, // 15秒
      critical: false
    });
  }
}

// 导出全局实例
export const healthMonitor = HealthMonitor.getInstance();

/**
 * 便捷函数：添加AI提供商健康检查
 */
export function addProviderHealthCheck(
  providerName: string,
  healthCheckUrl: string,
  critical: boolean = true
): void {
  healthMonitor.register({
    name: `provider_${providerName}`,
    description: `Check ${providerName} provider availability`,
    check: async () => {
      const startTime = Date.now();
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const response = await fetch(healthCheckUrl, {
          method: 'GET',
          signal: controller.signal,
          headers: { 'User-Agent': 'JPClaw-HealthCheck/1.0' }
        });
        
        clearTimeout(timeoutId);
        
        if (response.ok) {
          return {
            status: "healthy" as HealthStatus,
            message: `${providerName} is available`,
            details: { 
              status: response.status,
              statusText: response.statusText
            },
            timestamp: Date.now(),
            duration: Date.now() - startTime
          };
        } else {
          return {
            status: response.status >= 500 ? "unhealthy" : "degraded" as HealthStatus,
            message: `${providerName} returned ${response.status}`,
            details: { 
              status: response.status,
              statusText: response.statusText
            },
            timestamp: Date.now(),
            duration: Date.now() - startTime
          };
        }
      } catch (error) {
        return {
          status: "unhealthy" as HealthStatus,
          message: `${providerName} is unreachable`,
          details: { error: String(error) },
          timestamp: Date.now(),
          duration: Date.now() - startTime
        };
      }
    },
    timeout: 10000,
    interval: 60000, // 1分钟
    critical
  });
}

/**
 * 便捷函数：添加数据库健康检查
 */
export function addDatabaseHealthCheck(
  dbName: string,
  checkFn: () => Promise<boolean>,
  critical: boolean = true
): void {
  healthMonitor.register({
    name: `database_${dbName}`,
    description: `Check ${dbName} database connectivity`,
    check: async () => {
      const startTime = Date.now();
      try {
        const isConnected = await checkFn();
        
        if (isConnected) {
          return {
            status: "healthy" as HealthStatus,
            message: `${dbName} database is connected`,
            timestamp: Date.now(),
            duration: Date.now() - startTime
          };
        } else {
          return {
            status: "unhealthy" as HealthStatus,
            message: `${dbName} database connection failed`,
            timestamp: Date.now(),
            duration: Date.now() - startTime
          };
        }
      } catch (error) {
        return {
          status: "unhealthy" as HealthStatus,
          message: `${dbName} database error`,
          details: { error: String(error) },
          timestamp: Date.now(),
          duration: Date.now() - startTime
        };
      }
    },
    timeout: 5000,
    interval: 30000, // 30秒
    critical
  });
}