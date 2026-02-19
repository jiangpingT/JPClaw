/**
 * Embedding服务测试
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EmbeddingService } from "../src/js/memory/embedding-service.js";

describe("EmbeddingService", () => {
  let service: EmbeddingService;

  beforeEach(() => {
    // 使用simple provider进行测试，无需API key
    service = EmbeddingService.getInstance({
      provider: "simple",
      dimensions: 384
    });
  });

  describe("基础功能", () => {
    it("应该生成指定维度的embedding", async () => {
      const result = await service.getEmbedding("测试文本");

      expect(result.embedding).toBeDefined();
      expect(result.embedding.length).toBe(384);
      expect(result.model).toBe("simple-hash");
      expect(result.cached).toBe(false);
    });

    it("应该缓存相同文本的embedding", async () => {
      const text = "姜哥喜欢点外卖";

      const result1 = await service.getEmbedding(text);
      expect(result1.cached).toBe(false);

      const result2 = await service.getEmbedding(text);
      expect(result2.cached).toBe(true);
      expect(result2.embedding).toEqual(result1.embedding);
    });

    it("应该跳过缓存当skipCache=true", async () => {
      const text = "测试跳过缓存";

      await service.getEmbedding(text);
      const result = await service.getEmbedding(text, { skipCache: true });

      expect(result.cached).toBe(false);
    });

    it("embedding向量应该是归一化的", async () => {
      const result = await service.getEmbedding("归一化测试");

      const norm = Math.sqrt(
        result.embedding.reduce((sum, val) => sum + val * val, 0)
      );

      expect(norm).toBeCloseTo(1.0, 5);
    });

    it("相似文本应该有相似的embedding", async () => {
      const result1 = await service.getEmbedding("姜哥喜欢外卖");
      const result2 = await service.getEmbedding("姜哥喜欢点外卖");

      const similarity = cosineSimilarity(result1.embedding, result2.embedding);
      expect(similarity).toBeGreaterThan(0.8);
    });

    it("不同文本应该有不同的embedding", async () => {
      const result1 = await service.getEmbedding("姜哥喜欢外卖");
      const result2 = await service.getEmbedding("阿策是AI助手");

      const similarity = cosineSimilarity(result1.embedding, result2.embedding);
      expect(similarity).toBeLessThan(0.5);
    });
  });

  describe("批量处理", () => {
    it("应该支持批量获取embeddings", async () => {
      const texts = ["文本1", "文本2", "文本3"];
      const results = await service.getBatchEmbeddings(texts);

      expect(results.length).toBe(3);
      expect(results[0].embedding.length).toBe(384);
      expect(results[1].embedding.length).toBe(384);
      expect(results[2].embedding.length).toBe(384);
    });

    it("批量处理应该缓存每个结果", async () => {
      const texts = ["文本A", "文本B"];
      await service.getBatchEmbeddings(texts);

      const result = await service.getEmbedding("文本A");
      expect(result.cached).toBe(true);
    });
  });

  describe("缓存管理", () => {
    it("应该清理过期缓存", async () => {
      // 创建一个短TTL的实例
      const shortTTLService = EmbeddingService.getInstance({
        provider: "simple",
        cacheTTL: 100 // 100ms
      });

      await shortTTLService.getEmbedding("测试过期");
      await new Promise(resolve => setTimeout(resolve, 150));

      shortTTLService.cleanupCache();

      const stats = shortTTLService.getStatistics();
      expect(stats.cacheSize).toBe(0);
    });

    it("应该返回统计信息", () => {
      const stats = service.getStatistics();

      expect(stats).toHaveProperty("provider");
      expect(stats).toHaveProperty("model");
      expect(stats).toHaveProperty("cacheSize");
      expect(stats.provider).toBe("simple");
    });
  });

  describe("配置更新", () => {
    it("应该支持更新配置", () => {
      service.updateConfig({
        dimensions: 512
      });

      const stats = service.getStatistics();
      expect(stats).toBeDefined();
    });

    it("更换provider应该清空缓存", async () => {
      await service.getEmbedding("测试文本");

      const statsBefore = service.getStatistics();
      expect(statsBefore.cacheSize).toBeGreaterThan(0);

      service.updateConfig({
        provider: "openai"
      });

      const statsAfter = service.getStatistics();
      expect(statsAfter.cacheSize).toBe(0);
    });
  });

  describe("边界情况", () => {
    it("应该处理空文本", async () => {
      const result = await service.getEmbedding("");

      expect(result.embedding).toBeDefined();
      expect(result.embedding.length).toBe(384);
    });

    it("应该处理超长文本", async () => {
      const longText = "测试".repeat(10000);
      const result = await service.getEmbedding(longText);

      expect(result.embedding).toBeDefined();
      expect(result.embedding.length).toBe(384);
    });

    it("应该处理特殊字符", async () => {
      const result = await service.getEmbedding("!@#$%^&*()_+{}[]");

      expect(result.embedding).toBeDefined();
      expect(result.embedding.length).toBe(384);
    });

    it("应该处理中英文混合", async () => {
      const result = await service.getEmbedding("姜哥 likes 外卖 delivery");

      expect(result.embedding).toBeDefined();
      expect(result.embedding.length).toBe(384);
    });

    it("应该处理emoji", async () => {
      const result = await service.getEmbedding("😊🍔🚀");

      expect(result.embedding).toBeDefined();
      expect(result.embedding.length).toBe(384);
    });
  });
});

// 辅助函数：计算余弦相似度
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
