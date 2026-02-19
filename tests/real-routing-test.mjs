#!/usr/bin/env node

/**
 * JPClaw 真实路由测试 - 使用实际的 AI 路由器
 *
 * 这个脚本会调用真实的 maybeRunSkillFirst API 来测试路由准确性
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 简单的日志输出
const log = {
  info: (msg, data) => console.log(`ℹ️  ${msg}`, data || ''),
  warn: (msg, data) => console.log(`⚠️  ${msg}`, data || ''),
  error: (msg, data) => console.error(`❌ ${msg}`, data || '')
};

// Mock skill router - 调用真实的路由逻辑
async function testSkillRouting(query, expectedSkill) {
  try {
    // 这里我们需要导入并调用实际的 skill-router
    // 由于路由器需要完整的运行环境，我们通过 HTTP API 调用

    const response = await fetch('http://localhost:18788/api/test-route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const result = await response.json();
    return {
      routedSkill: result.skill || null,
      confidence: result.confidence || 0,
      reason: result.reason || '',
      matched: result.skill === expectedSkill
    };

  } catch (error) {
    log.warn(`路由测试失败: ${error.message}`);
    return {
      routedSkill: null,
      confidence: 0,
      reason: `错误: ${error.message}`,
      matched: false
    };
  }
}

// 主测试函数
async function runRealRoutingTests(options = {}) {
  const testFile = join(__dirname, 'skill-routing-tests.json');
  const data = JSON.parse(readFileSync(testFile, 'utf-8'));
  let testCases = data.testCases;

  // 应用过滤器
  if (options.limit) {
    testCases = testCases.slice(0, options.limit);
  }
  if (options.priority) {
    testCases = testCases.filter(tc => tc.priority === options.priority);
  }
  if (options.category) {
    testCases = testCases.filter(tc => tc.category === options.category);
  }

  console.log('\n🚀 开始真实路由测试...\n');
  console.log(`📋 将测试 ${testCases.length} 个用例\n`);

  const results = [];
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    console.log(`\n[${i + 1}/${testCases.length}] 测试: ${tc.skill}`);
    console.log(`   查询: "${tc.query}"`);
    console.log(`   期望: ${tc.expectedSkill}`);

    const result = await testSkillRouting(tc.query, tc.expectedSkill);

    const testResult = {
      id: tc.id,
      skill: tc.skill,
      query: tc.query,
      expectedSkill: tc.expectedSkill,
      routedSkill: result.routedSkill,
      confidence: result.confidence,
      matched: result.matched,
      reason: result.reason,
      category: tc.category,
      priority: tc.priority,
      timestamp: new Date().toISOString()
    };

    results.push(testResult);

    if (result.matched) {
      passed++;
      console.log(`   ✅ 通过 (置信度: ${result.confidence.toFixed(2)})`);
    } else {
      failed++;
      console.log(`   ❌ 失败: 路由到 ${result.routedSkill || '无'}`);
      if (result.reason) {
        console.log(`   原因: ${result.reason}`);
      }
    }

    // 避免过载
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // 生成报告
  const summary = {
    total: testCases.length,
    passed,
    failed,
    passRate: (passed / testCases.length * 100).toFixed(1),
    avgConfidence: (results.reduce((sum, r) => sum + (r.confidence || 0), 0) / results.length).toFixed(2),
    timestamp: new Date().toISOString()
  };

  const report = {
    summary,
    results
  };

  const reportPath = join(__dirname, `real-routing-report-${Date.now()}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // 打印总结
  console.log('\n\n========================================');
  console.log('  测试完成');
  console.log('========================================\n');
  console.log(`📊 总测试数: ${summary.total}`);
  console.log(`✅ 通过: ${summary.passed}`);
  console.log(`❌ 失败: ${summary.failed}`);
  console.log(`📈 通过率: ${summary.passRate}%`);
  console.log(`📊 平均置信度: ${summary.avgConfidence}`);
  console.log(`\n📄 报告已保存: ${reportPath}\n`);

  // 按类别统计
  const byCategory = {};
  results.forEach(r => {
    if (!byCategory[r.category]) {
      byCategory[r.category] = { total: 0, passed: 0 };
    }
    byCategory[r.category].total++;
    if (r.matched) byCategory[r.category].passed++;
  });

  console.log('\n📊 按类别统计:');
  Object.entries(byCategory)
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([cat, stats]) => {
      const rate = ((stats.passed / stats.total) * 100).toFixed(1);
      console.log(`   ${cat}: ${stats.passed}/${stats.total} (${rate}%)`);
    });

  // 失败的高优先级技能
  const failedHigh = results.filter(r => !r.matched && r.priority === 'high');
  if (failedHigh.length > 0) {
    console.log('\n⚠️  失败的高优先级技能:');
    failedHigh.forEach(r => {
      console.log(`   - ${r.skill}: "${r.query}"`);
    });
  }
}

// 解析命令行参数
const args = process.argv.slice(2);
const options = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit' && args[i + 1]) {
    options.limit = parseInt(args[i + 1]);
    i++;
  } else if (args[i] === '--priority' && args[i + 1]) {
    options.priority = args[i + 1];
    i++;
  } else if (args[i] === '--category' && args[i + 1]) {
    options.category = args[i + 1];
    i++;
  }
}

// 运行测试
runRealRoutingTests(options).catch(console.error);
