/**
 * 指标收集系统（阶段 4）
 *
 * 收集四维指标：
 * 1. 正确性（Correctness）
 * 2. 性能（Performance）
 * 3. 泛化能力（Generalization）
 * 4. AI Native 能力
 */

import { log } from "../shared/logger.js";

// ==================== 类型定义 ====================

/**
 * 正确性指标
 */
export interface CorrectnessMetrics {
  overall: number;              // 总体准确率
  precision: number;            // 精确率
  recall: number;               // 召回率
  f1Score: number;              // F1 分数

  byCategory: {
    skillRouting: number;       // 技能路由准确率
    openQA: number;             // 开放问答识别准确率
    slotDetection: number;      // 槽位检测准确率
  };
}

/**
 * 性能指标（阶段 5.5：增强）
 */
export interface PerformanceMetrics {
  latency: {
    avg: number;                // 平均响应时间（ms）
    p50: number;
    p95: number;
    p99: number;
  };

  throughput: number;           // 每分钟处理请求数

  breakdown: {
    stageA: number;             // 候选生成耗时
    stageB: number;             // 决策耗时
    skillExecution: number;     // 技能执行耗时
  };

  efficiency: {
    llmCalls: number;           // 平均 LLM 调用次数
    inputTokens: number;        // 输入 token
    outputTokens: number;       // 输出 token
    totalTokens: number;        // 总 token
    cacheHitRate: number;       // 缓存命中率
    cacheSavedTokens: number;   // 缓存节省的 token
    cost: number;               // 平均成本（USD/请求）
  };

  // 阶段 5.5：系统资源监控
  resources: {
    memory: {
      heapUsed: number;         // 堆内存使用（MB）
      heapTotal: number;        // 堆内存总量（MB）
      external: number;         // 外部内存（MB）
      rss: number;              // 常驻内存（MB）
    };
    cpu: {
      user: number;             // 用户态 CPU 时间（微秒）
      system: number;           // 系统态 CPU 时间（微秒）
    };
  };
}

/**
 * 泛化能力指标
 */
export interface GeneralizationMetrics {
  zeroShot: number;             // 零样本成功率
  semanticVariation: number;    // 语义理解能力
  typoTolerance: number;        // 拼写容忍度
  noiseResistance: number;      // 噪声抗性
  descriptionOnly: number;      // 仅靠描述路由成功率

  scalability: {
    [key: string]: number;      // "10-skills": 0.90
  };
}

/**
 * AI Native 指标
 */
export interface AINativeMetrics {
  aiDriven: number;             // AI 决策占比
  hardcoded: number;            // 硬编码规则占比

  confidenceCalibration: number; // 置信度校准度
  confidenceAccuracy: {
    high: number;               // confidence >= 0.8
    medium: number;             // 0.5-0.8
    low: number;                // < 0.5
  };

  degradationWisdom: number;    // 降级决策正确率
  clarificationWisdom: number;  // 追问决策正确率

  stageAFilterRate: number;     // Stage A 过滤率
  stageBAccuracy: number;       // Stage B 准确率

  autonomous: number;           // 自主决策成功率
}

/**
 * 综合指标
 */
export interface BenchmarkMetrics {
  correctness: CorrectnessMetrics;
  performance: PerformanceMetrics;
  generalization: GeneralizationMetrics;
  aiNative: AINativeMetrics;

  timestamp: number;
  version: string;
}

/**
 * 单次请求的指标记录
 */
export interface RequestMetrics {
  traceId: string;
  timestamp: number;

  // 输入信息
  input: string;
  expectedSkill: string | null;

  // 意图判定结果
  candidates: string[];
  selectedSkill: string | null;
  confidence: number;
  action: "run_skill" | "model_reply" | "clarify";

  // 正确性
  correct: boolean;

  // 性能
  executionTime: number;
  breakdown: {
    stageA: number;
    stageB: number;
    skillExecution: number;
  };

  // Token 消耗
  tokens: {
    stageA: { input: number; output: number };
    stageB: { input: number; output: number };
    total: number;
  };

  llmCalls: number;
  cacheHit: boolean;

  // AI Native
  aiDriven: boolean;
  confidenceBucket: "high" | "medium" | "low";
}

// ==================== 辅助函数 ====================

/**
 * 优化：使用线性插值计算百分位数（提高精度）
 * @param sortedArray 已排序的数组
 * @param percentile 百分位数 (0-1)
 */
function calculatePercentile(sortedArray: number[], percentile: number): number {
  if (sortedArray.length === 0) return 0;
  if (sortedArray.length === 1) return sortedArray[0];

  const index = percentile * (sortedArray.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  // 如果刚好是整数索引，直接返回
  if (lower === upper) {
    return sortedArray[lower];
  }

  // 线性插值
  const weight = index - lower;
  return sortedArray[lower] * (1 - weight) + sortedArray[upper] * weight;
}

// ==================== 指标收集器 ====================

export class MetricsCollector {
  private requests: RequestMetrics[] = [];
  private startTime: number = Date.now();

  /**
   * 记录单次请求
   */
  recordRequest(metrics: RequestMetrics): void {
    this.requests.push(metrics);

    log("info", "metrics.request_recorded", {
      traceId: metrics.traceId,
      correct: metrics.correct,
      executionTime: metrics.executionTime,
      totalTokens: metrics.tokens.total
    });
  }

  /**
   * 计算正确性指标
   */
  private calculateCorrectness(): CorrectnessMetrics {
    const total = this.requests.length;
    if (total === 0) {
      return {
        overall: 0,
        precision: 0,
        recall: 0,
        f1Score: 0,
        byCategory: { skillRouting: 0, openQA: 0, slotDetection: 0 }
      };
    }

    const correct = this.requests.filter(r => r.correct).length;

    // 精确率和召回率
    const truePositives = this.requests.filter(
      r => r.selectedSkill !== null && r.expectedSkill !== null && r.correct
    ).length;

    const predictedPositives = this.requests.filter(
      r => r.selectedSkill !== null
    ).length;

    const actualPositives = this.requests.filter(
      r => r.expectedSkill !== null
    ).length;

    const precision = predictedPositives > 0 ? truePositives / predictedPositives : 0;
    const recall = actualPositives > 0 ? truePositives / actualPositives : 0;
    const f1Score = (precision + recall) > 0
      ? 2 * (precision * recall) / (precision + recall)
      : 0;

    // 分类准确率
    const skillRoutingRequests = this.requests.filter(r => r.expectedSkill !== null);
    const skillRoutingCorrect = skillRoutingRequests.filter(r => r.correct).length;
    const skillRouting = skillRoutingRequests.length > 0
      ? skillRoutingCorrect / skillRoutingRequests.length
      : 0;

    const openQARequests = this.requests.filter(r => r.expectedSkill === null);
    const openQACorrect = openQARequests.filter(r => r.selectedSkill === null).length;
    const openQA = openQARequests.length > 0
      ? openQACorrect / openQARequests.length
      : 0;

    const slotDetectionRequests = this.requests.filter(r => r.action === "clarify");
    const slotDetectionCorrect = slotDetectionRequests.filter(r => r.correct).length;
    const slotDetection = slotDetectionRequests.length > 0
      ? slotDetectionCorrect / slotDetectionRequests.length
      : 0;

    return {
      overall: correct / total,
      precision,
      recall,
      f1Score,
      byCategory: {
        skillRouting,
        openQA,
        slotDetection
      }
    };
  }

  /**
   * 计算性能指标
   */
  private calculatePerformance(): PerformanceMetrics {
    const total = this.requests.length;
    if (total === 0) {
      const memoryUsage = process.memoryUsage();
      const cpuUsage = process.cpuUsage();

      return {
        latency: { avg: 0, p50: 0, p95: 0, p99: 0 },
        throughput: 0,
        breakdown: { stageA: 0, stageB: 0, skillExecution: 0 },
        efficiency: {
          llmCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheHitRate: 0,
          cacheSavedTokens: 0,
          cost: 0
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
    }

    // 延迟（优化：使用线性插值计算百分位数）
    const latencies = this.requests.map(r => r.executionTime).sort((a, b) => a - b);
    const avg = latencies.reduce((a, b) => a + b, 0) / total;
    const p50 = calculatePercentile(latencies, 0.5);
    const p95 = calculatePercentile(latencies, 0.95);
    const p99 = calculatePercentile(latencies, 0.99);

    // 吞吐量
    const durationMinutes = (Date.now() - this.startTime) / 60000;
    const throughput = durationMinutes > 0 ? total / durationMinutes : 0;

    // 耗时分解
    const avgStageA = this.requests.reduce((sum, r) => sum + r.breakdown.stageA, 0) / total;
    const avgStageB = this.requests.reduce((sum, r) => sum + r.breakdown.stageB, 0) / total;
    const avgSkillExecution = this.requests.reduce((sum, r) => sum + r.breakdown.skillExecution, 0) / total;

    // Token 效率
    const totalLLMCalls = this.requests.reduce((sum, r) => sum + r.llmCalls, 0);
    const totalInputTokens = this.requests.reduce((sum, r) =>
      sum + r.tokens.stageA.input + r.tokens.stageB.input, 0
    );
    const totalOutputTokens = this.requests.reduce((sum, r) =>
      sum + r.tokens.stageA.output + r.tokens.stageB.output, 0
    );
    const totalTokens = this.requests.reduce((sum, r) => sum + r.tokens.total, 0);

    const cacheHits = this.requests.filter(r => r.cacheHit).length;
    const cacheHitRate = cacheHits / total;

    // 估算缓存节省的 token（假设缓存命中时节省 1500 token）
    const cacheSavedTokens = cacheHits * 1500;

    // 成本（假设 $0.003/1K input tokens, $0.015/1K output tokens）
    const cost = (totalInputTokens * 0.003 + totalOutputTokens * 0.015) / 1000 / total;

    // 阶段 5.5：收集系统资源指标
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    return {
      latency: { avg, p50, p95, p99 },
      throughput,
      breakdown: {
        stageA: avgStageA,
        stageB: avgStageB,
        skillExecution: avgSkillExecution
      },
      efficiency: {
        llmCalls: totalLLMCalls / total,
        inputTokens: totalInputTokens / total,
        outputTokens: totalOutputTokens / total,
        totalTokens: totalTokens / total,
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
  }

  /**
   * 计算泛化能力指标（需要特定测试集）
   */
  calculateGeneralization(testResults: {
    zeroShot: { total: number; correct: number };
    semanticVariation: { total: number; correct: number };
    typoTolerance: { total: number; correct: number };
    noiseResistance: { total: number; correct: number };
    descriptionOnly: { total: number; correct: number };
    scalability: { [key: string]: { total: number; correct: number } };
  }): GeneralizationMetrics {
    const rate = (total: number, correct: number) => total > 0 ? correct / total : 0;

    const scalability: { [key: string]: number } = {};
    for (const [key, value] of Object.entries(testResults.scalability)) {
      scalability[key] = rate(value.total, value.correct);
    }

    return {
      zeroShot: rate(testResults.zeroShot.total, testResults.zeroShot.correct),
      semanticVariation: rate(testResults.semanticVariation.total, testResults.semanticVariation.correct),
      typoTolerance: rate(testResults.typoTolerance.total, testResults.typoTolerance.correct),
      noiseResistance: rate(testResults.noiseResistance.total, testResults.noiseResistance.correct),
      descriptionOnly: rate(testResults.descriptionOnly.total, testResults.descriptionOnly.correct),
      scalability
    };
  }

  /**
   * 计算 AI Native 指标
   */
  private calculateAINative(): AINativeMetrics {
    const total = this.requests.length;
    if (total === 0) {
      return {
        aiDriven: 0,
        hardcoded: 0,
        confidenceCalibration: 0,
        confidenceAccuracy: { high: 0, medium: 0, low: 0 },
        degradationWisdom: 0,
        clarificationWisdom: 0,
        stageAFilterRate: 0,
        stageBAccuracy: 0,
        autonomous: 0
      };
    }

    // AI 驱动占比
    const aiDrivenCount = this.requests.filter(r => r.aiDriven).length;
    const aiDriven = aiDrivenCount / total;
    const hardcoded = 1 - aiDriven;

    // 置信度校准（confidence 与实际准确率的匹配度）
    const highConfRequests = this.requests.filter(r => r.confidenceBucket === "high");
    const medConfRequests = this.requests.filter(r => r.confidenceBucket === "medium");
    const lowConfRequests = this.requests.filter(r => r.confidenceBucket === "low");

    const highAccuracy = highConfRequests.length > 0
      ? highConfRequests.filter(r => r.correct).length / highConfRequests.length
      : 0;
    const mediumAccuracy = medConfRequests.length > 0
      ? medConfRequests.filter(r => r.correct).length / medConfRequests.length
      : 0;
    const lowAccuracy = lowConfRequests.length > 0
      ? lowConfRequests.filter(r => r.correct).length / lowConfRequests.length
      : 0;

    // 置信度校准度（理想情况：high=0.95, medium=0.75, low=0.45）
    const expectedHigh = 0.95, expectedMed = 0.75, expectedLow = 0.45;
    const calibrationError = (
      Math.abs(highAccuracy - expectedHigh) +
      Math.abs(mediumAccuracy - expectedMed) +
      Math.abs(lowAccuracy - expectedLow)
    ) / 3;
    const confidenceCalibration = Math.max(0, 1 - calibrationError);

    // 降级智慧（应该降级的请求降级率）
    const shouldDegradeRequests = this.requests.filter(r => r.expectedSkill === null);
    const correctDegradations = shouldDegradeRequests.filter(r => r.action === "model_reply").length;
    const degradationWisdom = shouldDegradeRequests.length > 0
      ? correctDegradations / shouldDegradeRequests.length
      : 0;

    // 追问智慧（缺少槽位时追问率）
    const shouldClarifyRequests = this.requests.filter(r => r.action === "clarify");
    const correctClarifications = shouldClarifyRequests.filter(r => r.correct).length;
    const clarificationWisdom = shouldClarifyRequests.length > 0
      ? correctClarifications / shouldClarifyRequests.length
      : 0;

    // Stage A 过滤率（返回空候选的比例）
    const empty候选Requests = this.requests.filter(r => r.candidates.length === 0);
    const stageAFilterRate = empty候选Requests.length / total;

    // Stage B 准确率（候选不为空时的决策准确率）
    const nonEmptyCandidatesRequests = this.requests.filter(r => r.candidates.length > 0);
    const stageBCorrect = nonEmptyCandidatesRequests.filter(r => r.correct).length;
    const stageBAccuracy = nonEmptyCandidatesRequests.length > 0
      ? stageBCorrect / nonEmptyCandidatesRequests.length
      : 0;

    // 自主决策成功率（AI 全流程决策的成功率）
    const autonomousCount = this.requests.filter(r => r.aiDriven && r.correct).length;
    const autonomous = aiDrivenCount > 0 ? autonomousCount / aiDrivenCount : 0;

    return {
      aiDriven,
      hardcoded,
      confidenceCalibration,
      confidenceAccuracy: {
        high: highAccuracy,
        medium: mediumAccuracy,
        low: lowAccuracy
      },
      degradationWisdom,
      clarificationWisdom,
      stageAFilterRate,
      stageBAccuracy,
      autonomous
    };
  }

  /**
   * 生成完整报告
   */
  generateReport(generalizationResults?: {
    zeroShot: { total: number; correct: number };
    semanticVariation: { total: number; correct: number };
    typoTolerance: { total: number; correct: number };
    noiseResistance: { total: number; correct: number };
    descriptionOnly: { total: number; correct: number };
    scalability: { [key: string]: { total: number; correct: number } };
  }): BenchmarkMetrics {
    const correctness = this.calculateCorrectness();
    const performance = this.calculatePerformance();
    const generalization = generalizationResults
      ? this.calculateGeneralization(generalizationResults)
      : {
          zeroShot: 0,
          semanticVariation: 0,
          typoTolerance: 0,
          noiseResistance: 0,
          descriptionOnly: 0,
          scalability: {}
        };
    const aiNative = this.calculateAINative();

    return {
      correctness,
      performance,
      generalization,
      aiNative,
      timestamp: Date.now(),
      version: "4.0.0"
    };
  }

  /**
   * 重置收集器
   */
  reset(): void {
    this.requests = [];
    this.startTime = Date.now();
  }

  /**
   * 获取原始请求数据
   */
  getRawRequests(): RequestMetrics[] {
    return this.requests;
  }
}

// 全局单例
export const globalMetricsCollector = new MetricsCollector();
