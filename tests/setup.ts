/**
 * 测试环境设置
 */

import { vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 设置测试环境变量
process.env.NODE_ENV = 'test';
process.env.JPCLAW_LOG_LEVEL = 'error'; // 减少测试时的日志输出
process.env.JPCLAW_MEMORY_DIR = path.resolve(process.cwd(), 'tmp', 'test-memory');
process.env.JPCLAW_SESSIONS_DIR = path.resolve(process.cwd(), 'tmp', 'test-sessions');

// Mock全局对象
global.fetch = vi.fn();

// 创建测试目录
beforeAll(() => {
  const testDirs = [
    process.env.JPCLAW_MEMORY_DIR!,
    process.env.JPCLAW_SESSIONS_DIR!,
    path.resolve(process.cwd(), 'tmp', 'test-skills'),
    path.resolve(process.cwd(), 'tmp', 'test-media')
  ];

  for (const dir of testDirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
});

// 清理测试目录
afterAll(() => {
  const testTmpDir = path.resolve(process.cwd(), 'tmp');
  if (fs.existsSync(testTmpDir)) {
    fs.rmSync(testTmpDir, { recursive: true, force: true });
  }
});

// 重置模块和mocks
beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// 增强错误处理
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});