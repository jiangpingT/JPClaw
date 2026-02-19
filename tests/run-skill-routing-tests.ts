#!/usr/bin/env tsx
/**
 * JPClaw 技能路由测试 - 简化版
 * 通过 HTTP 调用 gateway 测试所有80个技能
 *
 * 作者: 阿策 for 姜哥
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { sendChatMessage } from '../dist/cli/chat.js';
import http from 'node:http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface TestCase {
  id: number;
  skill: string;
  query: string;
  expectedSkill: string;
  category: string;
  priority: string;
}

interface TestResult {
  id: number;
  skill: string;
  query: string;
  expected: string;
  actual: string | null;
  response: string;
  duration: number;
  success: boolean;
}

// 从响应中提取技能名称
function extractSkill(response: string): string | null {
  // 方法1: 直接匹配 [skill:xxx] 标识
  const skillTag = response.match(/\[skill:([a-z0-9-]+)\]/i);
  if (skillTag) return skillTag[1];

  // 方法2: 通过响应内容特征推断技能
  const text = response.toLowerCase();

  // web-search 特征
  if (/搜索结果|根据.*搜索|search results|科技新闻|新闻动态/i.test(response)) {
    return 'web-search';
  }

  // browser-automation 特征
  if (/截图|screenshot|playwright|chromium|browser.*automation|打开网页.*并|navigated to/i.test(response)) {
    return 'browser-automation';
  }

  // map-poi / goplaces 特征
  if (/附近.*咖啡|nearby.*cafe|poi.*results|找到.*家.*店|营业中|评分.*分|Starbucks|Arabica|Manner|Seesaw|Blue Bottle|📍.*地址|☎️.*电话/i.test(response)) {
    return text.includes('goplaces') ? 'goplaces' : 'map-poi';
  }

  // openai-image-gen 特征（包括错误响应）
  if (/image.*generated|图片.*生成|生成.*图片.*成功|GEMINI_API_KEY|OPENAI_API_KEY|图片生成功能|图像生成失败/i.test(response)) {
    return 'openai-image-gen';
  }

  // audio-stt 特征
  if (/transcription|转录.*完成|语音识别.*结果/i.test(response)) {
    return 'audio-stt';
  }

  // audio-tts 特征
  if (/audio.*generated|音频.*生成|语音.*合成.*完成/i.test(response)) {
    return 'audio-tts';
  }

  // github 特征
  if (/pull request|pr.*#\d+|latest.*pr|仓库.*pr/i.test(response)) {
    return 'github';
  }

  // weather 特征
  if (/温度|天气|humidity|temperature.*°|降水/i.test(response)) {
    return 'weather';
  }

  // web-scraper 特征
  if (/已成功抓取|抓取.*内容|HTML.*页面|内容概要|网页.*抓取|scrape.*success|fetched.*content|输出内容较大.*保存到文件/i.test(response)) {
    return 'web-scraper';
  }

  return null;
}

// 检查 Gateway
async function checkGateway(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 18790,
      path: '/health',
      method: 'GET',
      timeout: 3000
    }, (res) => {
      // 200=healthy, 503=degraded但仍可用
      resolve(res.statusCode === 200 || res.statusCode === 503);
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// 主测试函数
async function runTests(options: { limit?: number; priority?: string } = {}) {
  // 检查 Gateway
  console.log('\n检查 Gateway...');
  if (!await checkGateway()) {
    console.error('✗ Gateway 未运行 (端口 18790)');
    console.error('请先启动: npm run dev -- gateway\n');
    process.exit(1);
  }
  console.log('✓ Gateway 运行正常\n');

  // 加载测试用例
  const testFile = join(__dirname, 'skill-routing-tests.json');
  const data = JSON.parse(readFileSync(testFile, 'utf-8'));
  let tests: TestCase[] = data.testCases;

  // 过滤
  if (options.priority) {
    tests = tests.filter(t => t.priority === options.priority);
  }
  if (options.limit) {
    tests = tests.slice(0, options.limit);
  }

  console.log(`🚀 开始测试 ${tests.length} 个技能\n`);
  console.log('═'.repeat(60) + '\n');

  const results: TestResult[] = [];
  let passed = 0;

  for (let i = 0; i < tests.length; i++) {
    const tc = tests[i];
    const num = `[${i + 1}/${tests.length}]`;

    console.log(`${num} ${tc.skill}`);
    console.log(`    查询: "${tc.query}"`);

    const start = Date.now();
    let result: TestResult;

    try {
      // 使用唯一的userId避免会话记忆污染
      const uniqueUserId = `test-${tc.id}-${Date.now()}`;
      const response = await sendChatMessage(tc.query, {
        userId: uniqueUserId,
        userName: 'Tester',
        channelId: 'routing-test'
      });

      const actual = extractSkill(response);
      const success = actual === tc.expectedSkill;

      result = {
        id: tc.id,
        skill: tc.skill,
        query: tc.query,
        expected: tc.expectedSkill,
        actual,
        response: response.substring(0, 200),
        duration: Date.now() - start,
        success
      };

      if (success) {
        passed++;
        console.log(`    ✓ 通过 (${result.duration}ms)`);
      } else {
        console.log(`    ✗ 失败: 期望 ${tc.expectedSkill}, 实际 ${actual || 'null'}`);
      }

    } catch (error) {
      result = {
        id: tc.id,
        skill: tc.skill,
        query: tc.query,
        expected: tc.expectedSkill,
        actual: null,
        response: String(error),
        duration: Date.now() - start,
        success: false
      };
      console.log(`    ✗ 错误: ${error instanceof Error ? error.message : String(error)}`);
    }

    results.push(result);
    console.log('');

    // 延迟避免过载
    if (i < tests.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // 统计
  console.log('═'.repeat(60));
  console.log('\n📊 测试结果\n');
  console.log(`总数: ${tests.length}`);
  console.log(`通过: ${passed}`);
  console.log(`失败: ${tests.length - passed}`);
  console.log(`通过率: ${((passed / tests.length) * 100).toFixed(1)}%`);

  const avgDuration = results.reduce((s, r) => s + r.duration, 0) / results.length;
  console.log(`平均耗时: ${avgDuration.toFixed(0)}ms\n`);

  // 保存报告
  const reportFile = join(__dirname, `routing-test-${Date.now()}.json`);
  writeFileSync(reportFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    total: tests.length,
    passed,
    failed: tests.length - passed,
    passRate: (passed / tests.length) * 100,
    results
  }, null, 2));

  console.log(`📄 报告: ${reportFile}\n`);

  return passed === tests.length ? 0 : 1;
}

// CLI 入口
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法: tsx run-skill-routing-tests.ts [选项]\n');
    console.log('选项:');
    console.log('  --limit N          只测试前N个');
    console.log('  --priority <p>     只测试指定优先级 (high/medium/low)');
    console.log('  -h, --help         显示帮助\n');
    console.log('示例:');
    console.log('  tsx run-skill-routing-tests.ts --limit 10');
    console.log('  tsx run-skill-routing-tests.ts --priority high');
    return;
  }

  const options: { limit?: number; priority?: string } = {};

  const limitIdx = args.indexOf('--limit');
  if (limitIdx >= 0 && args[limitIdx + 1]) {
    options.limit = parseInt(args[limitIdx + 1]);
  }

  const priorityIdx = args.indexOf('--priority');
  if (priorityIdx >= 0 && args[priorityIdx + 1]) {
    options.priority = args[priorityIdx + 1];
  }

  const exitCode = await runTests(options);
  process.exit(exitCode);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
