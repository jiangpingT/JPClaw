#!/usr/bin/env tsx
/**
 * Embedding服务测试脚本
 * 使用方法: npm run dev -- scripts/test-embedding.ts
 */

import { embeddingService } from "../src/js/memory/embedding-service.js";
import { vectorMemoryStore } from "../src/js/memory/vector-store.js";

async function main() {
  console.log("=".repeat(60));
  console.log("JPClaw Embedding Service 测试");
  console.log("=".repeat(60));

  // 1. 测试embedding服务
  console.log("\n📊 1. Embedding服务统计");
  const stats = embeddingService.getStatistics();
  console.log("Provider:", stats.provider);
  console.log("Model:", stats.model);
  console.log("Cache size:", stats.cacheSize);

  // 2. 测试单个embedding生成
  console.log("\n🔍 2. 生成单个embedding");
  const text1 = "姜哥喜欢点外卖";
  const result1 = await embeddingService.getEmbedding(text1);
  console.log("文本:", text1);
  console.log("模型:", result1.model);
  console.log("维度:", result1.embedding.length);
  console.log("缓存:", result1.cached ? "命中" : "未命中");
  console.log("向量预览:", result1.embedding.slice(0, 5).map(v => v.toFixed(4)).join(", "), "...");

  // 3. 测试缓存
  console.log("\n💾 3. 测试缓存功能");
  const result2 = await embeddingService.getEmbedding(text1);
  console.log("再次获取相同文本:", result2.cached ? "✅ 缓存命中" : "❌ 缓存未命中");

  // 4. 测试批量处理
  console.log("\n📦 4. 批量生成embeddings");
  const texts = [
    "阿策是AI助手",
    "今天天气很好",
    "外卖平台有美团和饿了么"
  ];
  const batchResults = await embeddingService.getBatchEmbeddings(texts);
  console.log("批量处理文本数:", texts.length);
  console.log("生成结果数:", batchResults.length);
  for (let i = 0; i < batchResults.length; i++) {
    console.log(`  ${i + 1}. ${texts[i]} - ${batchResults[i].cached ? "缓存" : "新生成"}`);
  }

  // 5. 测试语义相似度
  console.log("\n🔗 5. 语义相似度测试");
  const testPairs = [
    ["姜哥喜欢外卖", "姜哥喜欢点外卖"],
    ["阿策是AI助手", "阿策帮助姜哥"],
    ["姜哥喜欢外卖", "今天下雨了"]
  ];

  for (const [text1, text2] of testPairs) {
    const emb1 = await embeddingService.getEmbedding(text1);
    const emb2 = await embeddingService.getEmbedding(text2);
    const similarity = cosineSimilarity(emb1.embedding, emb2.embedding);

    console.log(`\n  文本1: ${text1}`);
    console.log(`  文本2: ${text2}`);
    console.log(`  相似度: ${(similarity * 100).toFixed(2)}% ${getSimilarityEmoji(similarity)}`);
  }

  // 6. 测试向量存储集成
  console.log("\n🗄️  6. 向量存储集成测试");
  const userId = "test_user_" + Date.now();

  // 添加测试记忆
  const memories = [
    "姜哥称呼我阿策",
    "姜哥喜欢点外卖",
    "JPClaw是参考OpenClaw实现的",
    "OpenClaw源代码在/Users/mlamp/Workspace/OpenClaw"
  ];

  console.log("添加测试记忆...");
  for (const memory of memories) {
    await vectorMemoryStore.addMemory(memory, {
      userId,
      type: "profile",
      timestamp: Date.now(),
      importance: 0.8
    });
  }
  console.log(`✅ 已添加 ${memories.length} 条记忆`);

  // 语义搜索测试
  console.log("\n搜索测试:");
  const queries = [
    "姜哥怎么称呼你",
    "外卖相关的信息",
    "OpenClaw在哪里"
  ];

  for (const query of queries) {
    const results = await vectorMemoryStore.searchMemories({
      text: query,
      filters: { userId },
      limit: 2,
      threshold: 0.1
    });

    console.log(`\n  查询: ${query}`);
    if (results.length > 0) {
      results.forEach((result, index) => {
        console.log(`    ${index + 1}. ${result.vector.content}`);
        console.log(`       相似度: ${(result.similarity * 100).toFixed(2)}%`);
      });
    } else {
      console.log("    未找到相关记忆");
    }
  }

  // 7. 性能统计
  console.log("\n📈 7. 最终统计");
  const finalStats = embeddingService.getStatistics();
  const vectorStats = vectorMemoryStore.getStatistics();

  console.log("\nEmbedding服务:");
  console.log("  Provider:", finalStats.provider);
  console.log("  Model:", finalStats.model);
  console.log("  Cache size:", finalStats.cacheSize);

  console.log("\n向量存储:");
  console.log("  总向量数:", vectorStats.totalVectors);
  console.log("  用户数:", vectorStats.userCount);
  console.log("  类型分布:", JSON.stringify(vectorStats.typeDistribution));

  console.log("\n" + "=".repeat(60));
  console.log("✅ 测试完成!");
  console.log("=".repeat(60));
}

// 辅助函数
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) return 0;

  return dotProduct / (normA * normB);
}

function getSimilarityEmoji(similarity: number): string {
  if (similarity > 0.9) return "🔥 极高";
  if (similarity > 0.7) return "✅ 高";
  if (similarity > 0.5) return "⚡ 中";
  if (similarity > 0.3) return "⚠️  低";
  return "❌ 极低";
}

// 运行测试
main().catch(console.error);
