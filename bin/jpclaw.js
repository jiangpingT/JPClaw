#!/usr/bin/env node

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 获取项目根目录
const rootDir = resolve(__dirname, '..');

// CLI 入口文件路径
const cliPath = resolve(rootDir, 'src/js/cli/index.ts');

// 使用 tsx 运行 TypeScript CLI
const child = spawn(
  'node',
  [
    '--import', 'tsx',
    cliPath,
    ...process.argv.slice(2)
  ],
  {
    stdio: 'inherit',
    cwd: rootDir,
    env: process.env
  }
);

child.on('exit', (code) => {
  process.exit(code || 0);
});
