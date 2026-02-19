#!/usr/bin/env node

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 获取项目根目录
const rootDir = resolve(__dirname, '..');

// CLI chat 命令入口文件路径
const cliPath = resolve(rootDir, 'src/js/cli/index.ts');

// 所有参数都作为 chat 的输入内容
const chatArgs = process.argv.slice(2);

// 使用 tsx 运行 TypeScript CLI，传入 'chat' 命令和所有参数
// 通过环境变量标识这是从 jpchat 调用的，避免显示弃用警告
const child = spawn(
  'node',
  [
    '--import', 'tsx',
    cliPath,
    'chat',
    ...chatArgs
  ],
  {
    stdio: 'inherit',
    cwd: rootDir,
    env: {
      ...process.env,
      JPCHAT_COMMAND: '1' // 标识这是通过 jpchat 命令调用的
    }
  }
);

child.on('exit', (code) => {
  process.exit(code || 0);
});
