/**
 * 正确性测试模块
 *
 * 测试意图判定系统的准确率、精确率、召回率
 */

import { IntentSystem, type SkillMetadata } from "../channels/intent-system.js";
import { MetricsCollector, type RequestMetrics } from "./metrics-collector.js";
import { log } from "../shared/logger.js";

export interface CorrectnessTestCase {
  input: string;
  expected: string | null;  // null = 不应路由（开放问答）
  type: "positive" | "negative" | "clarify";
  missingSlots?: string[];
  category?: string;
}

export interface CorrectnessTestResult {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  accuracy: number;

  details: {
    input: string;
    expected: string | null;
    actual: string | null;
    correct: boolean;
    confidence: number;
    reason: string;
  }[];
}

export class CorrectnessTest {
  private intentSystem = new IntentSystem();
  private collector = new MetricsCollector();

  /**
   * 运行正确性测试
   */
  async run(
    testCases: CorrectnessTestCase[],
    skills: SkillMetadata[]
  ): Promise<CorrectnessTestResult> {
    log("info", "correctness_test.start", { totalCases: testCases.length });

    const details: CorrectnessTestResult["details"] = [];
    let passedCases = 0;

    for (const testCase of testCases) {
      const startTime = Date.now();

      try {
        // Stage A: 候选生成
        const stageAStart = Date.now();
        const candidatesResult = await this.intentSystem.generateCandidates(
          testCase.input,
          skills
        );
        const stageATime = Date.now() - stageAStart;

        if (!candidatesResult.ok) {
          details.push({
            input: testCase.input,
            expected: testCase.expected,
            actual: null,
            correct: false,
            confidence: 0,
            reason: `Stage A failed: ${candidatesResult.error.message}`
          });
          continue;
        }

        const candidates = candidatesResult.data;

        // Stage B: 决策
        const stageBStart = Date.now();
        let selectedSkill: string | null = null;
        let confidence = 0;
        let reason = "";

        if (candidates.length === 0) {
          // 无候选，应该是开放问答
          selectedSkill = null;
          confidence = 1.0;
          reason = "No candidates (open QA)";
        } else {
          const decisionResult = await this.intentSystem.decide(
            testCase.input,
            candidates,
            skills
          );
          const stageBTime = Date.now() - stageBStart;

          if (!decisionResult.ok) {
            details.push({
              input: testCase.input,
              expected: testCase.expected,
              actual: null,
              correct: false,
              confidence: 0,
              reason: `Stage B failed: ${decisionResult.error.message}`
            });
            continue;
          }

          const decision = decisionResult.data;
          confidence = decision.confidence;
          reason = decision.reason;

          if (decision.action === "run_skill") {
            selectedSkill = decision.skillName || null;
          } else if (decision.action === "clarify") {
            selectedSkill = "clarify";
          } else {
            selectedSkill = null;
          }

          // 记录指标
          const executionTime = Date.now() - startTime;
          const requestMetrics: RequestMetrics = {
            traceId: `correctness-test-${Date.now()}`,
            timestamp: Date.now(),
            input: testCase.input,
            expectedSkill: testCase.expected,
            candidates,
            selectedSkill,
            confidence,
            action: decision.action,
            correct: this.isCorrect(testCase, selectedSkill),
            executionTime,
            breakdown: {
              stageA: stageATime,
              stageB: stageBTime,
              skillExecution: 0
            },
            tokens: {
              stageA: { input: 500, output: 50 },  // 估算值
              stageB: { input: 600, output: 100 },
              total: 1250
            },
            llmCalls: 2,
            cacheHit: false,
            aiDriven: true,
            confidenceBucket: this.getConfidenceBucket(confidence)
          };

          this.collector.recordRequest(requestMetrics);
        }

        // 判断是否正确
        const correct = this.isCorrect(testCase, selectedSkill);
        if (correct) passedCases++;

        details.push({
          input: testCase.input,
          expected: testCase.expected,
          actual: selectedSkill,
          correct,
          confidence,
          reason
        });

      } catch (error) {
        details.push({
          input: testCase.input,
          expected: testCase.expected,
          actual: null,
          correct: false,
          confidence: 0,
          reason: `Error: ${String(error)}`
        });
      }
    }

    const accuracy = testCases.length > 0 ? passedCases / testCases.length : 0;

    log("info", "correctness_test.complete", {
      totalCases: testCases.length,
      passedCases,
      accuracy
    });

    return {
      totalCases: testCases.length,
      passedCases,
      failedCases: testCases.length - passedCases,
      accuracy,
      details
    };
  }

  /**
   * 判断结果是否正确
   */
  private isCorrect(testCase: CorrectnessTestCase, actual: string | null): boolean {
    if (testCase.type === "clarify") {
      return actual === "clarify";
    }
    return testCase.expected === actual;
  }

  /**
   * 获取置信度桶
   */
  private getConfidenceBucket(confidence: number): "high" | "medium" | "low" {
    if (confidence >= 0.8) return "high";
    if (confidence >= 0.5) return "medium";
    return "low";
  }

  /**
   * 获取指标收集器
   */
  getCollector(): MetricsCollector {
    return this.collector;
  }
}
