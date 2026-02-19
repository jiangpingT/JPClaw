import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendChatMessage } from "./chat.js";
import { log } from "../shared/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type TestCase = {
  id: number;
  skill: string;
  query: string;
  expectedSkill: string;
  category: string;
  priority: string;
};

type TestResult = {
  id: number;
  skill: string;
  query: string;
  expectedSkill: string;
  response: string;
  duration: number;
  timestamp: string;
  success: boolean;
  notes?: string;
};

/**
 * 从响应中提取技能路由信息
 */
function extractSkillFromResponse(response: string): string | null {
  // 匹配 "正在调用 xxx 技能" 或类似模式，以及 [skill:xxx] 格式
  const patterns = [
    /\[skill:([a-z0-9-]+)\]/i,
    /正在调用\s+([a-z0-9-]+)\s+技能/i,
    /调用技能[:：]\s*([a-z0-9-]+)/i,
    /使用技能[:：]\s*([a-z0-9-]+)/i,
    /executing skill[:：]\s*([a-z0-9-]+)/i,
    /running skill[:：]\s*([a-z0-9-]+)/i
  ];

  for (const pattern of patterns) {
    const match = response.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * 运行单个测试用例
 */
async function runTestCase(tc: TestCase): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const response = await sendChatMessage(tc.query);
    const duration = Date.now() - startTime;
    const routedSkill = extractSkillFromResponse(response);

    // 判断是否成功：
    // 1. 提取到了技能名
    // 2. 技能名匹配期望
    const success = routedSkill !== null && routedSkill === tc.expectedSkill;

    return {
      id: tc.id,
      skill: tc.skill,
      query: tc.query,
      expectedSkill: tc.expectedSkill,
      response: response.substring(0, 200), // 截取前200字符
      duration,
      timestamp: new Date().toISOString(),
      success,
      notes: routedSkill ? `实际路由: ${routedSkill}` : "未检测到技能路由"
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    return {
      id: tc.id,
      skill: tc.skill,
      query: tc.query,
      expectedSkill: tc.expectedSkill,
      response: `错误: ${error instanceof Error ? error.message : String(error)}`,
      duration,
      timestamp: new Date().toISOString(),
      success: false,
      notes: "执行失败"
    };
  }
}

/**
 * CLI命令: jpclaw test-routing
 */
export async function runTestRoutingCommand(args: string[]): Promise<number> {
  console.log("\n🚀 JPClaw 路由测试\n");
  console.log("═══════════════════════════════════════\n");

  // 解析参数
  const options: {
    limit?: number;
    priority?: string;
    category?: string;
    output?: string;
  } = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      options.limit = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === "--priority" && args[i + 1]) {
      options.priority = args[i + 1];
      i++;
    } else if (args[i] === "--category" && args[i + 1]) {
      options.category = args[i + 1];
      i++;
    } else if (args[i] === "--output" && args[i + 1]) {
      options.output = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("用法: jpclaw test-routing [选项]");
      console.log("");
      console.log("选项:");
      console.log("  --limit N          只测试前N个用例");
      console.log("  --priority <p>     只测试指定优先级 (high/medium/low)");
      console.log("  --category <c>     只测试指定类别");
      console.log("  --output <file>    保存结果到指定文件");
      console.log("  --help, -h         显示帮助");
      console.log("");
      console.log("示例:");
      console.log("  jpclaw test-routing --limit 10");
      console.log("  jpclaw test-routing --priority high");
      console.log("  jpclaw test-routing --category \"搜索与信息\"");
      console.log("  jpclaw test-routing --output results.json");
      console.log("");
      return 0;
    }
  }

  // 加载测试用例
  // 智能查找测试文件：先尝试当前目录，再尝试tests子目录
  let testFile = path.resolve(process.cwd(), "skill-routing-tests.json");

  if (!fs.existsSync(testFile)) {
    testFile = path.resolve(process.cwd(), "tests", "skill-routing-tests.json");
  }

  if (!fs.existsSync(testFile)) {
    console.error(`❌ 找不到测试文件\n`);
    console.error(`尝试了以下路径:`);
    console.error(`  - ${path.resolve(process.cwd(), "skill-routing-tests.json")}`);
    console.error(`  - ${path.resolve(process.cwd(), "tests", "skill-routing-tests.json")}\n`);
    return 1;
  }

  const data = JSON.parse(fs.readFileSync(testFile, "utf-8"));
  let testCases: TestCase[] = data.testCases;

  // 应用过滤
  if (options.limit) {
    testCases = testCases.slice(0, options.limit);
  }
  if (options.priority) {
    testCases = testCases.filter((tc) => tc.priority === options.priority);
  }
  if (options.category) {
    testCases = testCases.filter((tc) => tc.category === options.category);
  }

  console.log(`📋 测试用例数: ${testCases.length}\n`);
  console.log("开始测试...\n");
  console.log("═══════════════════════════════════════\n");

  const results: TestResult[] = [];
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const testNum = `[${i + 1}/${testCases.length}]`;

    console.log(`${testNum} 测试: \x1b[33m${tc.skill}\x1b[0m`);
    console.log(`    查询: "${tc.query}"`);
    console.log(`    期望: ${tc.expectedSkill}`);

    const result = await runTestCase(tc);
    results.push(result);

    if (result.success) {
      passed++;
      console.log(`    \x1b[32m✅ 通过\x1b[0m (耗时: ${result.duration}ms)`);
    } else {
      failed++;
      console.log(`    \x1b[31m❌ 失败\x1b[0m: ${result.notes}`);
      if (result.response.length < 100) {
        console.log(`    响应: ${result.response}`);
      }
    }

    console.log("");

    // 避免过载
    if (i < testCases.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // 生成报告
  console.log("═══════════════════════════════════════");
  console.log("  测试完成");
  console.log("═══════════════════════════════════════\n");

  const passRate = ((passed / testCases.length) * 100).toFixed(1);
  const avgDuration = (
    results.reduce((sum, r) => sum + r.duration, 0) / results.length
  ).toFixed(0);

  console.log(`📊 总测试数: ${testCases.length}`);
  console.log(`✅ 通过: \x1b[32m${passed}\x1b[0m`);
  console.log(`❌ 失败: \x1b[31m${failed}\x1b[0m`);
  console.log(`📈 通过率: \x1b[33m${passRate}%\x1b[0m`);
  console.log(`⏱️  平均耗时: ${avgDuration}ms`);

  // 按类别统计
  const byCategory: Record<string, { total: number; passed: number }> = {};
  results.forEach((r) => {
    const cat = testCases.find((tc) => tc.id === r.id)?.category || "Unknown";
    if (!byCategory[cat]) {
      byCategory[cat] = { total: 0, passed: 0 };
    }
    byCategory[cat].total++;
    if (r.success) byCategory[cat].passed++;
  });

  console.log("\n📊 按类别统计:");
  Object.entries(byCategory)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 10)
    .forEach(([cat, stats]) => {
      const rate = ((stats.passed / stats.total) * 100).toFixed(0);
      console.log(`   ${cat}: ${stats.passed}/${stats.total} (${rate}%)`);
    });

  // 保存报告
  const report = {
    summary: {
      total: testCases.length,
      passed,
      failed,
      passRate: parseFloat(passRate),
      avgDuration: parseFloat(avgDuration),
      timestamp: new Date().toISOString()
    },
    results,
    byCategory
  };

  // 智能确定输出目录
  const outputDir = process.cwd().endsWith('/tests')
    ? process.cwd()
    : path.resolve(process.cwd(), "tests");

  const outputFile =
    options.output ||
    path.resolve(outputDir, `routing-test-${Date.now()}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2));

  console.log(`\n📄 详细报告: ${outputFile}\n`);

  // 生成Markdown报告
  const mdReport = generateMarkdownReport(report, testCases);
  const mdFile = outputFile.replace(/\.json$/, ".md");
  fs.writeFileSync(mdFile, mdReport);
  console.log(`📄 Markdown 报告: ${mdFile}\n`);

  return failed === 0 ? 0 : 1;
}

/**
 * 生成Markdown报告
 */
function generateMarkdownReport(
  report: any,
  testCases: TestCase[]
): string {
  let md = "# JPClaw 路由测试报告\n\n";
  md += `**生成时间**: ${new Date().toISOString()}\n\n`;
  md += "## 测试概览\n\n";
  md += `- 📊 **总测试数**: ${report.summary.total}\n`;
  md += `- ✅ **通过**: ${report.summary.passed}\n`;
  md += `- ❌ **失败**: ${report.summary.failed}\n`;
  md += `- 📈 **通过率**: ${report.summary.passRate}%\n`;
  md += `- ⏱️ **平均耗时**: ${report.summary.avgDuration}ms\n\n`;
  md += "---\n\n";

  md += "## 按类别统计\n\n";
  md += "| 类别 | 通过 | 总数 | 通过率 |\n";
  md += "|------|------|------|--------|\n";
  Object.entries(report.byCategory)
    .sort((a: any, b: any) => b[1].total - a[1].total)
    .forEach(([cat, stats]: [string, any]) => {
      const rate = ((stats.passed / stats.total) * 100).toFixed(0);
      md += `| ${cat} | ${stats.passed} | ${stats.total} | ${rate}% |\n`;
    });

  md += "\n---\n\n";
  md += "## 测试结果详情\n\n";

  report.results.forEach((r: TestResult) => {
    const icon = r.success ? "✅" : "❌";
    md += `### ${icon} Test #${r.id}: ${r.skill}\n\n`;
    md += `- **查询**: "${r.query}"\n`;
    md += `- **期望**: ${r.expectedSkill}\n`;
    md += `- **结果**: ${r.success ? "通过 ✅" : "失败 ❌"}\n`;
    md += `- **耗时**: ${r.duration}ms\n`;
    if (r.notes) {
      md += `- **说明**: ${r.notes}\n`;
    }
    if (!r.success && r.response) {
      md += `- **响应**: ${r.response}\n`;
    }
    md += "\n";
  });

  return md;
}
