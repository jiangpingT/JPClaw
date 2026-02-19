#!/usr/bin/env node
/**
 * 媒体功能基础测试套件
 *
 * 使用方法:
 *   node tests/media-basic-test.js
 *
 * 环境变量:
 *   GEMINI_API_KEY - Gemini API密钥 (必需)
 *   OPENAI_API_KEY - OpenAI API密钥 (可选)
 */

import { run as runImageGen } from '../skills/openai-image-gen/index.js';
import { run as runVideoGen } from '../skills/video-frames/index.js';
import { run as runTranscript } from '../skills/transcript-fast/index.js';
import fs from 'fs';
import path from 'path';

// ANSI颜色代码
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
};

// 测试结果收集器
class TestRunner {
  constructor() {
    this.results = [];
    this.startTime = Date.now();
  }

  async test(name, fn) {
    process.stdout.write(`${colors.blue}→${colors.reset} ${name} ... `);
    const start = Date.now();

    try {
      await fn();
      const duration = Date.now() - start;
      console.log(`${colors.green}✓${colors.reset} ${colors.gray}(${duration}ms)${colors.reset}`);
      this.results.push({ name, status: 'passed', duration });
    } catch (error) {
      const duration = Date.now() - start;
      console.log(`${colors.red}✗${colors.reset} ${colors.gray}(${duration}ms)${colors.reset}`);
      console.log(`  ${colors.red}Error: ${error.message}${colors.reset}`);
      if (error.details) {
        console.log(`  ${colors.gray}Details: ${error.details}${colors.reset}`);
      }
      this.results.push({ name, status: 'failed', duration, error: error.message });
    }
  }

  printSummary() {
    const totalDuration = Date.now() - this.startTime;
    const passed = this.results.filter(r => r.status === 'passed').length;
    const failed = this.results.filter(r => r.status === 'failed').length;

    console.log('\n' + '='.repeat(60));
    console.log(`Test Summary (${totalDuration}ms total)`);
    console.log('='.repeat(60));
    console.log(`${colors.green}Passed: ${passed}${colors.reset}`);
    console.log(`${colors.red}Failed: ${failed}${colors.reset}`);
    console.log(`Total: ${this.results.length}`);

    if (failed > 0) {
      console.log(`\n${colors.red}Failed Tests:${colors.reset}`);
      this.results
        .filter(r => r.status === 'failed')
        .forEach(r => console.log(`  - ${r.name}`));
    }

    return failed === 0 ? 0 : 1;
  }
}

// 断言辅助函数
function assert(condition, message, details = null) {
  if (!condition) {
    const error = new Error(message);
    if (details) error.details = details;
    throw error;
  }
}

function assertExists(value, name) {
  assert(value !== null && value !== undefined, `${name} should exist`);
}

function assertEquals(actual, expected, name) {
  assert(actual === expected, `${name} should be ${expected}, got ${actual}`);
}

// 清理测试文件
function cleanupTestFiles() {
  const testDir = path.resolve(process.cwd(), 'sessions/media/test-outputs');
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDir, { recursive: true });
}

// 测试用例定义
async function runTests() {
  const runner = new TestRunner();

  console.log(`${colors.blue}Starting Media Function Tests${colors.reset}\n`);

  // ========== 图片生成测试 ==========
  console.log(`${colors.yellow}Image Generation Tests${colors.reset}`);

  await runner.test('TC-IMG-001: Basic image generation (Gemini)', async () => {
    const input = JSON.stringify({
      prompt: '一只在草地上奔跑的金毛犬',
      provider: 'gemini',
      quality: 'standard',
      filename: 'sessions/media/test-outputs/test-dog.png',
    });

    const result = JSON.parse(await runImageGen(input));

    assertExists(result, 'result');
    assertEquals(result.ok, true, 'result.ok');
    assertEquals(result.task, 'image', 'result.task');
    assertEquals(result.route.provider, 'gemini', 'provider');

    // 验证文件存在
    const outputPath = result.result.outputPath;
    assert(fs.existsSync(outputPath), 'Output image file should exist', outputPath);

    // 验证文件大小
    const stats = fs.statSync(outputPath);
    assert(stats.size > 0, 'Image file size should be > 0', `Size: ${stats.size} bytes`);
  });

  await runner.test('TC-IMG-008: Empty prompt validation', async () => {
    const input = JSON.stringify({
      prompt: '',
    });

    const result = JSON.parse(await runImageGen(input));

    assertEquals(result.ok, false, 'result.ok');
    assertEquals(result.error, 'missing_prompt', 'error code');
  });

  await runner.test('TC-IMG-007: Very long prompt', async () => {
    const longPrompt = '一个非常详细的场景描述，' + '包含大量细节信息，'.repeat(50);

    const input = JSON.stringify({
      prompt: longPrompt,
      provider: 'gemini',
      filename: 'sessions/media/test-outputs/test-long-prompt.png',
    });

    const result = JSON.parse(await runImageGen(input));

    // 即使很长也应该成功
    assertEquals(result.ok, true, 'result.ok');
  });

  await runner.test('TC-IMG-018: Path traversal prevention', async () => {
    const input = JSON.stringify({
      prompt: '测试图片',
      filename: '../../etc/passwd.png',
    });

    const result = JSON.parse(await runImageGen(input));

    assertEquals(result.ok, false, 'result.ok');
    assert(
      result.error.includes('Path not allowed') || result.error.includes('not allowed'),
      'Should reject dangerous path',
      result.error
    );
  });

  // ========== 视频生成测试 ==========
  console.log(`\n${colors.yellow}Video Generation Tests${colors.reset}`);

  await runner.test('TC-VID-007: Missing prompt validation', async () => {
    const input = JSON.stringify({
      duration_seconds: 4,
    });

    const result = JSON.parse(await runVideoGen(input));

    assertEquals(result.ok, false, 'result.ok');
    assertEquals(result.error, 'missing_prompt', 'error code');
  });

  await runner.test('TC-VID-001: Basic video generation (Gemini)', async () => {
    // 注意: 这个测试会调用实际API，消耗配额
    // 如果不想运行，可以跳过
    if (process.env.SKIP_EXPENSIVE_TESTS === 'true') {
      console.log('  (Skipped - set SKIP_EXPENSIVE_TESTS=false to run)');
      return;
    }

    const input = JSON.stringify({
      prompt: '海浪轻柔地拍打着沙滩',
      provider: 'gemini',
      duration_seconds: 4,
      aspect_ratio: '16:9',
      quality: 'standard',
    });

    const result = JSON.parse(await runVideoGen(input));

    assertExists(result, 'result');
    assertEquals(result.ok, true, 'result.ok');
    assertEquals(result.route.provider, 'gemini', 'provider');
  });

  // ========== 字幕提取测试 ==========
  console.log(`\n${colors.yellow}Transcript Tests${colors.reset}`);

  await runner.test('TC-TRANS-005: Invalid URL validation', async () => {
    const input = JSON.stringify({
      url: 'https://example.com/not-a-video',
    });

    const result = JSON.parse(await runTranscript(input));

    assertEquals(result.ok, false, 'result.ok');
    assertEquals(result.error, 'invalid_youtube_url', 'error code');
  });

  await runner.test('TC-TRANS-001: YouTube transcript extraction', async () => {
    // 使用一个已知有字幕的视频
    const input = JSON.stringify({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      maxSegments: 10,
    });

    const result = JSON.parse(await runTranscript(input));

    assertExists(result, 'result');
    assertEquals(result.ok, true, 'result.ok');
    assertExists(result.videoId, 'videoId');
    assertExists(result.segments, 'segments');
    assert(result.segments.length > 0, 'Should have segments');
    assert(result.segments.length <= 10, 'Should respect maxSegments');
  });

  await runner.test('TC-TRANS-004: Different URL formats', async () => {
    const urls = [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
    ];

    for (const url of urls) {
      const input = JSON.stringify({ url, maxSegments: 5 });
      const result = JSON.parse(await runTranscript(input));

      assertEquals(result.videoId, 'dQw4w9WgXcQ', `videoId from ${url}`);
    }
  });

  // ========== 媒体路由器测试 ==========
  console.log(`\n${colors.yellow}Media Router Tests${colors.reset}`);

  await runner.test('TC-ROUTER-001: Auto provider selection (free_first)', async () => {
    const input = JSON.stringify({
      prompt: '测试',
      budget_mode: 'free_first',
      filename: 'sessions/media/test-outputs/test-router.png',
    });

    const result = JSON.parse(await runImageGen(input));

    assertEquals(result.ok, true, 'result.ok');
    assertEquals(result.route.provider, 'gemini', 'Should use Gemini in free_first mode');
  });

  await runner.test('TC-ROUTER-007: Plain text input parsing', async () => {
    const input = '一只可爱的猫咪';

    const result = JSON.parse(await runImageGen(input));

    // 应该能够解析纯文本作为prompt
    assertEquals(result.ok, true, 'result.ok');
  });

  // ========== 集成测试 ==========
  console.log(`\n${colors.yellow}Integration Tests${colors.reset}`);

  await runner.test('TC-E2E-001: Complete image generation workflow', async () => {
    const outputPath = 'sessions/media/test-outputs/e2e-test.png';

    // 步骤1: 生成图片
    const genInput = JSON.stringify({
      prompt: '一个简单的红色圆圈',
      provider: 'gemini',
      filename: outputPath,
    });

    const genResult = JSON.parse(await runImageGen(genInput));
    assertEquals(genResult.ok, true, 'Generation should succeed');

    // 步骤2: 验证文件
    assert(fs.existsSync(outputPath), 'File should exist');

    // 步骤3: 验证预算记录
    const ledgerPath = path.resolve(process.cwd(), 'sessions/media/budget-ledger.json');
    if (fs.existsSync(ledgerPath)) {
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
      const today = new Date().toISOString().split('T')[0];
      assertExists(ledger[today], 'Today\'s budget record');
      assert(ledger[today].image > 0, 'Image budget should be recorded');
    }
  });

  // 打印测试总结
  console.log('');
  const exitCode = runner.printSummary();

  // 清理测试文件 (可选)
  if (process.env.CLEANUP_TEST_FILES !== 'false') {
    console.log(`\n${colors.gray}Cleaning up test files...${colors.reset}`);
    // cleanupTestFiles();  // 取消注释以启用清理
  }

  return exitCode;
}

// 主函数
async function main() {
  // 检查必需的环境变量
  if (!process.env.GEMINI_API_KEY) {
    console.error(`${colors.red}Error: GEMINI_API_KEY environment variable is required${colors.reset}`);
    console.error('Set it with: export GEMINI_API_KEY=your-api-key');
    process.exit(1);
  }

  try {
    const exitCode = await runTests();
    process.exit(exitCode);
  } catch (error) {
    console.error(`${colors.red}Unexpected error: ${error.message}${colors.reset}`);
    console.error(error.stack);
    process.exit(1);
  }
}

// 运行测试
main();
