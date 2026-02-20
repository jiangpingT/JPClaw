/**
 * 性能监控和指标收集系统
 * 提供实时性能指标监控、告警和统计
 */

import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { log, logMetric } from "../shared/logger.js";

/**
 * 扩展的请求类型（支持中间件添加的自定义属性）
 */
interface ExtendedRequest extends IncomingMessage {
  method?: string;
  url?: string;
  route?: string;
}

export type MetricType = "counter" | "gauge" | "histogram" | "timer";

export interface MetricData {
  name: string;
  type: MetricType;
  value: number;
  timestamp: number;
  tags?: Record<string, string>;
  unit?: string;
}

export interface PerformanceSnapshot {
  timestamp: number;
  metrics: Record<string, MetricData>;
  summary: {
    totalRequests: number;
    errorRate: number;
    avgResponseTime: number;
    memoryUsage: NodeJS.MemoryUsage;
    cpuUsage: NodeJS.CpuUsage;
  };
}

class MetricsCollector {
  private static instance: MetricsCollector;
  private metrics = new Map<string, MetricData>();
  private timers = new Map<string, { start: number; tags?: Record<string, string> }>();
  private counters = new Map<string, number>();
  private histograms = new Map<string, number[]>();
  private startTime = Date.now();
  private lastCpuUsage?: NodeJS.CpuUsage;

  // 优化：保存定时器引用以便清理
  private cleanupTimer?: NodeJS.Timeout;
  private systemMetricsTimer?: NodeJS.Timeout;
  private snapshotTimer?: NodeJS.Timeout;

  private constructor() {
    // P1-10修复: 启动时加载历史数据
    this.loadHistoricalData().catch(error => {
      log("warn", "Failed to load historical metrics data", { error: String(error) });
    });

    // 定期清理过期指标 - 更频繁地清理
    this.cleanupTimer = setInterval(() => this.cleanupExpiredMetrics(), 2 * 60 * 1000); // 2分钟（从5分钟改为2分钟）

    // 定期收集系统指标
    this.systemMetricsTimer = setInterval(() => this.collectSystemMetrics(), 30 * 1000); // 30秒

    // 定期生成快照 - 减少频率以降低磁盘和内存压力
    this.snapshotTimer = setInterval(() => this.generateSnapshot(), 5 * 60 * 1000); // 5分钟（从1分钟改为5分钟）
  }

  static getInstance(): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector();
    }
    return MetricsCollector.instance;
  }

  /**
   * 优化：销毁实例（清理定时器和资源）
   */
  destroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.systemMetricsTimer) clearInterval(this.systemMetricsTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);

    this.metrics.clear();
    this.histograms.clear();
    this.counters.clear();
    this.timers.clear();

    log("info", "metrics.collector.destroyed");
  }

  /**
   * 优化：销毁单例实例
   */
  static destroyInstance(): void {
    if (MetricsCollector.instance) {
      MetricsCollector.instance.destroy();
      MetricsCollector.instance = undefined as unknown as MetricsCollector;
    }
  }

  /**
   * 计数器：递增计数
   */
  increment(name: string, value: number = 1, tags?: Record<string, string>): void {
    const key = this.buildKey(name, tags);
    this.counters.set(key, (this.counters.get(key) || 0) + value);
    
    this.setMetric({
      name,
      type: "counter",
      value: this.counters.get(key)!,
      timestamp: Date.now(),
      tags
    });

    logMetric(name, value, "count", tags);
  }

  /**
   * 仪表盘：直接设置值
   */
  gauge(name: string, value: number, tags?: Record<string, string>, unit?: string): void {
    this.setMetric({
      name,
      type: "gauge",
      value,
      timestamp: Date.now(),
      tags,
      unit
    });

    logMetric(name, value, unit || "value", tags);
  }

  /**
   * 直方图：记录数值分布
   */
  histogram(name: string, value: number, tags?: Record<string, string>): void {
    const key = this.buildKey(name, tags);
    const values = this.histograms.get(key) || [];
    values.push(value);
    
    // 保留最近1000个值
    if (values.length > 1000) {
      values.splice(0, values.length - 1000);
    }
    
    this.histograms.set(key, values);

    // 计算统计值
    const sorted = [...values].sort((a, b) => a - b);
    const len = sorted.length;
    
    this.setMetric({
      name: `${name}.p50`,
      type: "gauge",
      value: len > 0 ? sorted[Math.floor(len * 0.5)] : 0,
      timestamp: Date.now(),
      tags
    });

    this.setMetric({
      name: `${name}.p95`,
      type: "gauge", 
      value: len > 0 ? sorted[Math.floor(len * 0.95)] : 0,
      timestamp: Date.now(),
      tags
    });

    this.setMetric({
      name: `${name}.p99`,
      type: "gauge",
      value: len > 0 ? sorted[Math.floor(len * 0.99)] : 0,
      timestamp: Date.now(),
      tags
    });

    logMetric(`${name}.histogram`, value, "value", tags);
  }

  /**
   * 计时器：开始计时
   */
  startTimer(name: string, tags?: Record<string, string>): string {
    const timerId = `${name}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.timers.set(timerId, { start: Date.now(), tags });
    return timerId;
  }

  /**
   * 计时器：结束计时
   */
  endTimer(timerId: string): number | null {
    const timer = this.timers.get(timerId);
    if (!timer) return null;

    const duration = Date.now() - timer.start;
    this.timers.delete(timerId);

    const name = timerId.split('_')[0];
    this.histogram(name, duration, timer.tags);
    
    this.setMetric({
      name,
      type: "timer",
      value: duration,
      timestamp: Date.now(),
      tags: timer.tags,
      unit: "ms"
    });

    return duration;
  }

  /**
   * 直接记录耗时
   */
  timing(name: string, value: number, tags?: Record<string, string>): void {
    this.histogram(name, value, tags);
    this.setMetric({
      name,
      type: "timer",
      value,
      timestamp: Date.now(),
      tags,
      unit: "ms"
    });
  }

  /**
   * 简化的计时方法
   */
  async time<T>(
    name: string,
    fn: () => Promise<T>,
    tags?: Record<string, string>
  ): Promise<T> {
    const timerId = this.startTimer(name, tags);
    try {
      const result = await fn();
      const duration = this.endTimer(timerId);
      
      // 记录成功
      this.increment(`${name}.success`, 1, tags);
      
      return result;
    } catch (error) {
      this.endTimer(timerId);
      
      // 记录失败
      this.increment(`${name}.error`, 1, {
        ...tags,
        error_type: error instanceof Error ? error.constructor.name : "unknown"
      });
      
      throw error;
    }
  }

  /**
   * 获取指标
   */
  getMetric(name: string, tags?: Record<string, string>): MetricData | undefined {
    const key = this.buildKey(name, tags);
    return this.metrics.get(key);
  }

  /**
   * 获取所有指标
   */
  getAllMetrics(): Record<string, MetricData> {
    const result: Record<string, MetricData> = {};
    for (const [key, metric] of this.metrics) {
      result[key] = metric;
    }
    return result;
  }

  /**
   * 生成性能快照
   */
  generateSnapshot(): PerformanceSnapshot {
    const now = Date.now();
    const metrics = this.getAllMetrics();
    
    // 计算汇总统计
    let totalRequests = 0;
    let errorCount = 0;
    let responseTimes: number[] = [];

    for (const metric of Object.values(metrics)) {
      if (metric.name.includes("request") && metric.type === "counter") {
        totalRequests += metric.value;
      }
      if (metric.name.includes("error") && metric.type === "counter") {
        errorCount += metric.value;
      }
      if (metric.name.includes("response_time") && metric.type === "timer") {
        responseTimes.push(metric.value);
      }
    }

    const errorRate = totalRequests > 0 ? (errorCount / totalRequests) * 100 : 0;
    const avgResponseTime = responseTimes.length > 0 
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length 
      : 0;

    const snapshot: PerformanceSnapshot = {
      timestamp: now,
      metrics,
      summary: {
        totalRequests,
        errorRate,
        avgResponseTime,
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage()
      }
    };

    // 保存快照到文件
    this.saveSnapshot(snapshot);

    // 检查告警条件
    this.checkAlerts(snapshot);

    return snapshot;
  }

  private setMetric(metric: MetricData): void {
    const key = this.buildKey(metric.name, metric.tags);
    this.metrics.set(key, metric);
  }

  private buildKey(name: string, tags?: Record<string, string>): string {
    if (!tags || Object.keys(tags).length === 0) {
      return name;
    }
    
    const tagStr = Object.entries(tags)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(',');
    
    return `${name}|${tagStr}`;
  }

  private collectSystemMetrics(): void {
    // 内存使用情况
    const memUsage = process.memoryUsage();
    this.gauge("system.memory.heap_used", memUsage.heapUsed, undefined, "bytes");
    this.gauge("system.memory.heap_total", memUsage.heapTotal, undefined, "bytes");
    this.gauge("system.memory.external", memUsage.external, undefined, "bytes");
    this.gauge("system.memory.rss", memUsage.rss, undefined, "bytes");

    // CPU 使用情况
    const cpuUsage = process.cpuUsage(this.lastCpuUsage);
    this.lastCpuUsage = process.cpuUsage();
    
    this.gauge("system.cpu.user", cpuUsage.user, undefined, "microseconds");
    this.gauge("system.cpu.system", cpuUsage.system, undefined, "microseconds");

    // 运行时间
    this.gauge("system.uptime", Date.now() - this.startTime, undefined, "ms");

    // 事件循环延迟 (简化版本)
    const start = process.hrtime.bigint();
    setImmediate(() => {
      const delta = process.hrtime.bigint() - start;
      this.gauge("system.event_loop.delay", Number(delta / 1000000n), undefined, "ms");
    });
  }

  private cleanupExpiredMetrics(): void {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10分钟

    // 清理过期的 metrics
    for (const [key, metric] of this.metrics) {
      if (now - metric.timestamp > maxAge) {
        this.metrics.delete(key);
      }
    }

    // 清理 histograms - 限制总数量和单个 histogram 的大小
    const maxHistograms = 100; // 最多保留 100 个不同的 histogram
    const maxValuesPerHistogram = 500; // 每个 histogram 最多 500 个值（从 1000 减少）

    if (this.histograms.size > maxHistograms) {
      // 删除最旧的 histograms
      const keysToDelete = Array.from(this.histograms.keys()).slice(0, this.histograms.size - maxHistograms);
      for (const key of keysToDelete) {
        this.histograms.delete(key);
      }
    }

    // 清理每个 histogram 中的值
    for (const [key, values] of this.histograms) {
      if (values.length > maxValuesPerHistogram) {
        values.splice(0, values.length - maxValuesPerHistogram);
      }
    }

    // 清理 counters - 限制数量
    const maxCounters = 200;
    if (this.counters.size > maxCounters) {
      const keysToDelete = Array.from(this.counters.keys()).slice(0, this.counters.size - maxCounters);
      for (const key of keysToDelete) {
        this.counters.delete(key);
      }
    }

    // 清理僵尸 timers：startTimer() 后未调用 endTimer()（如中途抛异常）
    // 超过 5 分钟未结束的计时器视为泄漏，强制删除
    const timerMaxAge = 5 * 60 * 1000;
    for (const [timerId, timer] of this.timers) {
      if (now - timer.start > timerMaxAge) {
        this.timers.delete(timerId);
        log("warn", "metrics.timer.leaked", { timerId, ageMs: now - timer.start });
      }
    }
  }

  /**
   * P1-10修复: 启动时加载历史数据
   * 从最近的快照文件恢复指标数据
   */
  private async loadHistoricalData(): Promise<void> {
    try {
      const dir = path.resolve(process.cwd(), "log", "metrics");

      // 检查目录是否存在
      try {
        await fs.promises.access(dir);
      } catch {
        log("info", "No historical metrics data found (first run)");
        return;
      }

      // 读取所有快照文件
      const files = await fs.promises.readdir(dir);
      const snapshotFiles = files
        .filter(f => f.startsWith("snapshot_") && f.endsWith(".json"))
        .sort()
        .reverse(); // 最新的在前

      if (snapshotFiles.length === 0) {
        log("info", "No historical metrics snapshots found");
        return;
      }

      // 加载最近的快照
      const latestFile = snapshotFiles[0];
      const filepath = path.join(dir, latestFile);
      const content = await fs.promises.readFile(filepath, 'utf-8');
      const snapshot: PerformanceSnapshot = JSON.parse(content);

      // 恢复 metrics 数据
      let restoredCount = 0;
      for (const [name, metricData] of Object.entries(snapshot.metrics)) {
        this.metrics.set(name, metricData);

        // 恢复 counters
        if (metricData.type === 'counter') {
          const key = this.buildKey(metricData.name, metricData.tags);
          this.counters.set(key, metricData.value);
        }

        restoredCount++;
      }

      log("info", "Historical metrics data loaded", {
        file: latestFile,
        metricsRestored: restoredCount,
        snapshotAge: Math.floor((Date.now() - snapshot.timestamp) / 1000 / 60) + " minutes"
      });

    } catch (error) {
      log("error", "Failed to load historical metrics data", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * 优化：使用异步文件操作（避免阻塞事件循环）
   */
  private async saveSnapshot(snapshot: PerformanceSnapshot): Promise<void> {
    try {
      const dir = path.resolve(process.cwd(), "log", "metrics");
      await fs.promises.mkdir(dir, { recursive: true });

      const filename = `snapshot_${new Date(snapshot.timestamp).toISOString().replace(/[:.]/g, '-')}.json`;
      const filepath = path.join(dir, filename);

      await fs.promises.writeFile(filepath, JSON.stringify(snapshot, null, 2));

      // 异步清理旧文件（不阻塞主流程）
      this.cleanupOldSnapshots(dir).catch(error => {
        log("warn", "Async snapshot cleanup failed", { error: String(error) });
      });
    } catch (error) {
      log("error", "Failed to save metrics snapshot", { error: String(error) });
    }
  }

  /**
   * 优化：使用异步文件操作清理旧快照
   * P1-10修复: 保留时间从24小时改为7天
   */
  private async cleanupOldSnapshots(dir: string): Promise<void> {
    try {
      const files = await fs.promises.readdir(dir);
      const now = Date.now();
      const maxAge = 7 * 24 * 60 * 60 * 1000; // P1-10: 7天（从24小时增加）

      for (const file of files) {
        if (!file.startsWith("snapshot_") || !file.endsWith(".json")) continue;

        const filepath = path.join(dir, file);
        const stats = await fs.promises.stat(filepath);

        if (now - stats.mtime.getTime() > maxAge) {
          await fs.promises.unlink(filepath);
        }
      }
    } catch (error) {
      log("warn", "Failed to cleanup old snapshots", { error: String(error) });
    }
  }

  private checkAlerts(snapshot: PerformanceSnapshot): void {
    const { summary } = snapshot;

    // 错误率告警
    if (summary.errorRate > 5) { // 5%
      log("error", "🚨 ALERT: High error rate detected", {
        alert: true,
        errorRate: summary.errorRate,
        totalRequests: summary.totalRequests
      });
    }

    // 响应时间告警
    if (summary.avgResponseTime > 5000) { // 5秒
      log("error", "🚨 ALERT: High response time detected", {
        alert: true,
        avgResponseTime: summary.avgResponseTime
      });
    }

    // 内存使用告警
    const heapUsagePercent = (summary.memoryUsage.heapUsed / summary.memoryUsage.heapTotal) * 100;
    if (heapUsagePercent > 90) { // 90%
      log("error", "🚨 ALERT: High memory usage detected", {
        alert: true,
        heapUsagePercent,
        heapUsed: summary.memoryUsage.heapUsed,
        heapTotal: summary.memoryUsage.heapTotal
      });
    }
  }
}

// 导出全局实例
export const metrics = MetricsCollector.getInstance();

/**
 * 优化：销毁监控系统（用于优雅关闭）
 */
export function destroyMetrics(): void {
  MetricsCollector.destroyInstance();
}

/**
 * 中间件：为 HTTP 请求添加指标收集
 */
export function createMetricsMiddleware() {
  return function (req: ExtendedRequest, res: ServerResponse, next: () => void) {
    const startTime = Date.now();
    
    // 请求开始
    metrics.increment("http.requests", 1, {
      method: req.method || "UNKNOWN",
      route: (req.route as { path?: string })?.path || req.url || "",
    });

    // 监听响应结束
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      const statusCode = res.statusCode;
      const tags = {
        method: req.method || "UNKNOWN",
        status_code: statusCode.toString(),
        route: (req.route as { path?: string })?.path || req.url || "",
      };

      // 响应时间
      metrics.histogram("http.response_time", duration, tags);
      
      // 状态码统计
      metrics.increment(`http.responses.${Math.floor(statusCode / 100)}xx`, 1, tags);
      
      // 错误统计
      if (statusCode >= 400) {
        metrics.increment("http.errors", 1, tags);
      }
    });

    next();
  };
}

/**
 * 装饰器：为函数添加性能监控
 */
export function monitored(metricName?: string) {
  return function (target: object, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const name = metricName || `${(target as { constructor: { name: string } }).constructor.name}.${propertyKey}`;

    descriptor.value = async function (...args: unknown[]) {
      return metrics.time(name, async () => {
        return await originalMethod.apply(this, args);
      }, {
        class: target.constructor.name,
        method: propertyKey
      });
    };

    return descriptor;
  };
}