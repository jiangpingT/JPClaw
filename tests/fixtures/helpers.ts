/**
 * 测试工具函数和共享辅助方法
 *
 * 所有测试文件应从此处导入通用工具，
 * 避免在测试文件中重复定义 mock 和辅助函数。
 */

/**
 * 余弦相似度计算（用于向量测试）
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Vector dimensions mismatch");
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 生成随机向量（用于 embedding 测试）
 */
export function randomVector(dimensions: number = 128): number[] {
  const vec = Array.from({ length: dimensions }, () => Math.random() - 0.5);
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return vec.map(v => v / norm); // 归一化
}

/**
 * 等待指定毫秒（用于异步测试）
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 创建临时测试目录
 */
export function createTempDir(prefix: string = 'jpclaw-test-'): string {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}
