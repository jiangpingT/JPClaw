/**
 * 性能测试模块
 *
 * 测试响应时间、吞吐量、Token 消耗
 */

import { IntentSystem, type SkillMetadata } from "../channels/intent-system.js";
import type { PerformanceMetrics } from "./metrics-collector.js";
import { log } from "../shared/logger.js";

/**
 * 优化：使用线性插值计算百分位数（提高精度）
 */
function calculatePercentile(sortedArray: number[], percentile: number): number {
  if (sortedArray.length === 0) return 0;
  if (sortedArray.length === 1) return sortedArray[0];

  const index = percentile * (sortedArray.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sortedArray[lower];
  }

  const weight = index - lower;
  return sortedArray[lower] * (1 - weight) + sortedArray[upper] * weight;
}

export interface PerformanceTestCase {
  input: string;
  concurrency?: number;  // 并发数
}

export interface PerformanceTestResult {
  metrics: PerformanceMetrics;

  concurrencyTests: {
    concurrency: number;
    avgLatency: number;
    p95Latency: number;
    throughput: number;
  }[];
}

export class PerformanceTest {
  private intentSystem = new IntentSystem();

  /**
   * 运行性能测试
   */
  async run(
    testCases: PerformanceTestCase[],
    skills: SkillMetadata[]
  ): Promise<PerformanceTestResult> {
    log("info", "performance_test.start", { totalCases: testCases.length });

    const latencies: number[] = [];
    const breakdowns: { stageA: number; stageB: number }[] = [];
    const tokenUsage: { input: number; output: number }[] = [];
    let totalLLMCalls = 0;
    let cacheHits = 0;

    const startTime = Date.now();

    // 单次执行测试
    for (const testCase of testCases) {
      const requestStart = Date.now();

      try {
        // Stage A
        const stageAStart = Date.now();
        const candidatesResult = await this.intentSystem.generateCandidates(
          testCase.input,
          skills
        );
        const stageATime = Date.now() - stageAStart;

        if (!candidatesResult.ok) continue;

        const candidates = candidatesResult.data;
        totalLLMCalls++;

        // 估算 token（实际应从 LLM 响应中获取）
        const stageATokens = { input: 500, output: 50 };
        tokenUsage.push(stageATokens);

        // Stage B
        if (candidates.length > 0) {
          const stageBStart = Date.now();
          const decisionResult = await this.intentSystem.decide(
            testCase.input,
            candidates,
            skills
          );
          const stageBTime = Date.now() - stageBStart;

          if (decisionResult.ok) {
            totalLLMCalls++;
            const stageBTokens = { input: 600, output: 100 };
            tokenUsage.push(stageBTokens);

            breakdowns.push({
              stageA: stageATime,
              stageB: stageBTime
            });
          }
        } else {
          breakdowns.push({
            stageA: stageATime,
            stageB: 0
          });
        }

        const latency = Date.now() - requestStart;
        latencies.push(latency);

      } catch (error) {
        log("warn", "performance_test.error", { error: String(error) });
      }
    }

    // 计算指标（优化：使用线性插值）
    latencies.sort((a, b) => a - b);
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const p50Latency = calculatePercentile(latencies, 0.5);
    const p95Latency = calculatePercentile(latencies, 0.95);
    const p99Latency = calculatePercentile(latencies, 0.99);

    const durationMinutes = (Date.now() - startTime) / 60000;
    const throughput = durationMinutes > 0 ? testCases.length / durationMinutes : 0;

    const avgStageA = breakdowns.reduce((sum, b) => sum + b.stageA, 0) / breakdowns.length;
    const avgStageB = breakdowns.reduce((sum, b) => sum + b.stageB, 0) / breakdowns.length;

    const totalInputTokens = tokenUsage.reduce((sum, t) => sum + t.input, 0);
    const totalOutputTokens = tokenUsage.reduce((sum, t) => sum + t.output, 0);
    const totalTokens = totalInputTokens + totalOutputTokens;

    const avgInputTokens = totalInputTokens / testCases.length;
    const avgOutputTokens = totalOutputTokens / testCases.length;
    const avgTotalTokens = totalTokens / testCases.length;

    const cacheHitRate = cacheHits / testCases.length;
    const cacheSavedTokens = cacheHits * 1500;

    // 成本计算（$0.003/1K input, $0.015/1K output）
    const cost = (totalInputTokens * 0.003 + totalOutputTokens * 0.015) / 1000 / testCases.length;

    // 收集系统资源指标
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    const metrics: PerformanceMetrics = {
      latency: {
        avg: avgLatency,
        p50: p50Latency,
        p95: p95Latency,
        p99: p99Latency
      },
      throughput,
      breakdown: {
        stageA: avgStageA,
        stageB: avgStageB,
        skillExecution: 0  // 性能测试不执行真实技能
      },
      efficiency: {
        llmCalls: totalLLMCalls / testCases.length,
        inputTokens: avgInputTokens,
        outputTokens: avgOutputTokens,
        totalTokens: avgTotalTokens,
        cacheHitRate,
        cacheSavedTokens,
        cost
      },
      resources: {
        memory: {
          heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
          heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
          external: Math.round(memoryUsage.external / 1024 / 1024),
          rss: Math.round(memoryUsage.rss / 1024 / 1024)
        },
        cpu: {
          user: cpuUsage.user,
          system: cpuUsage.system
        }
      }
    };

    // 并发测试（可选）
    const concurrencyTests = await this.runConcurrencyTests(testCases.slice(0, 10), skills);

    log("info", "performance_test.complete", {
      avgLatency,
      p95Latency,
      throughput
    });

    return {
      metrics,
      concurrencyTests
    };
  }

  /**
   * 运行并发测试
   */
  private async runConcurrencyTests(
    testCases: PerformanceTestCase[],
    skills: SkillMetadata[]
  ): Promise<PerformanceTestResult["concurrencyTests"]> {
    const concurrencyLevels = [1, 5, 10];
    const results: PerformanceTestResult["concurrencyTests"] = [];

    for (const concurrency of concurrencyLevels) {
      const startTime = Date.now();
      const latencies: number[] = [];

      // 分批并发执行
      const batches = Math.ceil(testCases.length / concurrency);
      for (let i = 0; i < batches; i++) {
        const batch = testCases.slice(i * concurrency, (i + 1) * concurrency);
        const promises = batch.map(async (testCase) => {
          const reqStart = Date.now();
          try {
            await this.intentSystem.generateCandidates(testCase.input, skills);
            const latency = Date.now() - reqStart;
            latencies.push(latency);
          } catch (error) {
            // 忽略错误
          }
        });

        // P0-1修复: 使用 Promise.allSettled 确保所有测试完成
        await Promise.allSettled(promises);
      }

      latencies.sort((a, b) => a - b);
      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const p95Latency = calculatePercentile(latencies, 0.95);

      const durationMinutes = (Date.now() - startTime) / 60000;
      const throughput = durationMinutes > 0 ? testCases.length / durationMinutes : 0;

      results.push({
        concurrency,
        avgLatency,
        p95Latency,
        throughput
      });
    }

    return results;
  }
}
