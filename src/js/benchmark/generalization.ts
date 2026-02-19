/**
 * 泛化能力测试模块
 *
 * 测试零样本学习、语义理解、鲁棒性、可扩展性
 */

import { IntentSystem, type SkillMetadata } from "../channels/intent-system.js";
import type { GeneralizationMetrics } from "./metrics-collector.js";
import { log } from "../shared/logger.js";

export interface GeneralizationTestSuite {
  zeroShot: {
    setup: string;
    tempSkill: SkillMetadata;
    cases: { input: string; expected: string }[];
  };

  semanticVariation: {
    cases: { input: string; expected: string }[];
  };

  typoTolerance: {
    cases: { input: string; expected: string; note: string }[];
  };

  noiseResistance: {
    cases: { input: string; expected: string; note: string }[];
  };

  descriptionOnly: {
    cases: { input: string; expected: string }[];
  };

  scalability: {
    scenarios: {
      skillCount: number;
      testCases: { input: string; expected: string }[];
    }[];
  };
}

export interface GeneralizationTestResult {
  metrics: GeneralizationMetrics;

  details: {
    category: string;
    totalCases: number;
    passedCases: number;
    accuracy: number;
    failures: { input: string; expected: string; actual: string }[];
  }[];
}

export class GeneralizationTest {
  private intentSystem = new IntentSystem();

  /**
   * 运行泛化能力测试
   */
  async run(
    testSuite: GeneralizationTestSuite,
    baseSkills: SkillMetadata[]
  ): Promise<GeneralizationTestResult> {
    log("info", "generalization_test.start");

    const results: GeneralizationTestResult["details"] = [];

    // 1. 零样本测试
    const zeroShotResult = await this.testZeroShot(testSuite.zeroShot, baseSkills);
    results.push(zeroShotResult);

    // 2. 语义变化测试
    const semanticResult = await this.testSemanticVariation(
      testSuite.semanticVariation.cases,
      baseSkills
    );
    results.push(semanticResult);

    // 3. 拼写容忍度测试
    const typoResult = await this.testTypoTolerance(
      testSuite.typoTolerance.cases,
      baseSkills
    );
    results.push(typoResult);

    // 4. 噪声抗性测试
    const noiseResult = await this.testNoiseResistance(
      testSuite.noiseResistance.cases,
      baseSkills
    );
    results.push(noiseResult);

    // 5. 仅靠描述路由测试
    const descResult = await this.testDescriptionOnly(
      testSuite.descriptionOnly.cases,
      baseSkills
    );
    results.push(descResult);

    // 6. 可扩展性测试
    const scaleResult = await this.testScalability(
      testSuite.scalability.scenarios,
      baseSkills
    );
    results.push(...scaleResult);

    // 计算综合指标
    const metrics = this.calculateMetrics(results);

    log("info", "generalization_test.complete", { metrics });

    return {
      metrics,
      details: results
    };
  }

  /**
   * 零样本测试
   */
  private async testZeroShot(
    config: GeneralizationTestSuite["zeroShot"],
    baseSkills: SkillMetadata[]
  ): Promise<GeneralizationTestResult["details"][0]> {
    const skills = [...baseSkills, config.tempSkill];
    let passedCases = 0;
    const failures: { input: string; expected: string; actual: string }[] = [];

    for (const testCase of config.cases) {
      const actual = await this.runIntent(testCase.input, skills);
      if (actual === testCase.expected) {
        passedCases++;
      } else {
        failures.push({ ...testCase, actual: actual || "null" });
      }
    }

    return {
      category: "零样本学习",
      totalCases: config.cases.length,
      passedCases,
      accuracy: config.cases.length > 0 ? passedCases / config.cases.length : 0,
      failures
    };
  }

  /**
   * 语义变化测试
   */
  private async testSemanticVariation(
    cases: { input: string; expected: string }[],
    skills: SkillMetadata[]
  ): Promise<GeneralizationTestResult["details"][0]> {
    let passedCases = 0;
    const failures: { input: string; expected: string; actual: string }[] = [];

    for (const testCase of cases) {
      const actual = await this.runIntent(testCase.input, skills);
      if (actual === testCase.expected) {
        passedCases++;
      } else {
        failures.push({ ...testCase, actual: actual || "null" });
      }
    }

    return {
      category: "语义理解",
      totalCases: cases.length,
      passedCases,
      accuracy: cases.length > 0 ? passedCases / cases.length : 0,
      failures
    };
  }

  /**
   * 拼写容忍度测试
   */
  private async testTypoTolerance(
    cases: { input: string; expected: string; note: string }[],
    skills: SkillMetadata[]
  ): Promise<GeneralizationTestResult["details"][0]> {
    let passedCases = 0;
    const failures: { input: string; expected: string; actual: string }[] = [];

    for (const testCase of cases) {
      const actual = await this.runIntent(testCase.input, skills);
      if (actual === testCase.expected) {
        passedCases++;
      } else {
        failures.push({ input: testCase.input, expected: testCase.expected, actual: actual || "null" });
      }
    }

    return {
      category: "拼写容忍度",
      totalCases: cases.length,
      passedCases,
      accuracy: cases.length > 0 ? passedCases / cases.length : 0,
      failures
    };
  }

  /**
   * 噪声抗性测试
   */
  private async testNoiseResistance(
    cases: { input: string; expected: string; note: string }[],
    skills: SkillMetadata[]
  ): Promise<GeneralizationTestResult["details"][0]> {
    let passedCases = 0;
    const failures: { input: string; expected: string; actual: string }[] = [];

    for (const testCase of cases) {
      const actual = await this.runIntent(testCase.input, skills);
      if (actual === testCase.expected) {
        passedCases++;
      } else {
        failures.push({ input: testCase.input, expected: testCase.expected, actual: actual || "null" });
      }
    }

    return {
      category: "噪声抗性",
      totalCases: cases.length,
      passedCases,
      accuracy: cases.length > 0 ? passedCases / cases.length : 0,
      failures
    };
  }

  /**
   * 仅靠描述路由测试
   */
  private async testDescriptionOnly(
    cases: { input: string; expected: string }[],
    skills: SkillMetadata[]
  ): Promise<GeneralizationTestResult["details"][0]> {
    let passedCases = 0;
    const failures: { input: string; expected: string; actual: string }[] = [];

    for (const testCase of cases) {
      const actual = await this.runIntent(testCase.input, skills);
      if (actual === testCase.expected) {
        passedCases++;
      } else {
        failures.push({ ...testCase, actual: actual || "null" });
      }
    }

    return {
      category: "仅靠描述路由",
      totalCases: cases.length,
      passedCases,
      accuracy: cases.length > 0 ? passedCases / cases.length : 0,
      failures
    };
  }

  /**
   * 可扩展性测试
   */
  private async testScalability(
    scenarios: GeneralizationTestSuite["scalability"]["scenarios"],
    baseSkills: SkillMetadata[]
  ): Promise<GeneralizationTestResult["details"]> {
    const results: GeneralizationTestResult["details"] = [];

    for (const scenario of scenarios) {
      // 生成虚拟技能以达到指定数量
      const dummySkills: SkillMetadata[] = [];
      const neededDummies = scenario.skillCount - baseSkills.length;

      for (let i = 0; i < neededDummies; i++) {
        dummySkills.push({
          name: `dummy-skill-${i}`,
          description: `虚拟技能 ${i}，用于测试可扩展性`,
          requiredSlots: []
        });
      }

      const skills = [...baseSkills, ...dummySkills];

      let passedCases = 0;
      const failures: { input: string; expected: string; actual: string }[] = [];

      for (const testCase of scenario.testCases) {
        const actual = await this.runIntent(testCase.input, skills);
        if (actual === testCase.expected) {
          passedCases++;
        } else {
          failures.push({ ...testCase, actual: actual || "null" });
        }
      }

      results.push({
        category: `可扩展性-${scenario.skillCount}技能`,
        totalCases: scenario.testCases.length,
        passedCases,
        accuracy: scenario.testCases.length > 0 ? passedCases / scenario.testCases.length : 0,
        failures
      });
    }

    return results;
  }

  /**
   * 执行意图判定
   */
  private async runIntent(input: string, skills: SkillMetadata[]): Promise<string | null> {
    try {
      const candidatesResult = await this.intentSystem.generateCandidates(input, skills);
      if (!candidatesResult.ok || candidatesResult.data.length === 0) {
        return null;
      }

      const decisionResult = await this.intentSystem.decide(
        input,
        candidatesResult.data,
        skills
      );

      if (!decisionResult.ok) {
        return null;
      }

      const decision = decisionResult.data;
      if (decision.action === "run_skill") {
        return decision.skillName || null;
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * 计算综合指标
   */
  private calculateMetrics(
    details: GeneralizationTestResult["details"]
  ): GeneralizationMetrics {
    const getAccuracy = (category: string) => {
      const item = details.find(d => d.category.includes(category));
      return item ? item.accuracy : 0;
    };

    const scalability: { [key: string]: number } = {};
    details
      .filter(d => d.category.startsWith("可扩展性"))
      .forEach(d => {
        const match = d.category.match(/(\d+)技能/);
        if (match) {
          scalability[`${match[1]}-skills`] = d.accuracy;
        }
      });

    return {
      zeroShot: getAccuracy("零样本"),
      semanticVariation: getAccuracy("语义理解"),
      typoTolerance: getAccuracy("拼写容忍"),
      noiseResistance: getAccuracy("噪声抗性"),
      descriptionOnly: getAccuracy("仅靠描述"),
      scalability
    };
  }
}
