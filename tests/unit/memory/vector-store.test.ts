/**
 * 向量记忆存储单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VectorMemoryStore, type MemoryVector, type SemanticQuery } from '../../../src/js/memory/vector-store.js';

describe('VectorMemoryStore', () => {
  let memoryStore: VectorMemoryStore;
  const testUserId = 'test-user-123';

  beforeEach(() => {
    // 每个测试使用新的实例
    memoryStore = new VectorMemoryStore();
  });

  afterEach(async () => {
    // 清理测试数据
    const userMemories = memoryStore.getUserMemories(testUserId);
    for (const memory of userMemories) {
      memoryStore.removeMemory(memory.id);
    }
  });

  describe('addMemory', () => {
    it('should add a new memory vector', async () => {
      const content = "我喜欢吃披萨";
      const metadata = {
        userId: testUserId,
        type: "shortTerm" as const,
        timestamp: Date.now(),
        importance: 0.7
      };

      const memoryId = await memoryStore.addMemory(content, metadata);

      expect(memoryId).toBeDefined();
      expect(memoryId).toMatch(/^mem_[a-f0-9]+_\d+$/);

      const userMemories = memoryStore.getUserMemories(testUserId);
      expect(userMemories).toHaveLength(1);
      expect(userMemories[0].content).toBe(content);
      expect(userMemories[0].metadata.importance).toBe(0.7);
    });

    it('should limit importance to 0-1 range', async () => {
      const content = "测试重要性限制";
      const metadata = {
        userId: testUserId,
        type: "longTerm" as const,
        timestamp: Date.now(),
        importance: 0.5
      };

      await memoryStore.addMemory(content, metadata, 1.5); // 超出范围

      const userMemories = memoryStore.getUserMemories(testUserId);
      expect(userMemories[0].metadata.importance).toBe(1); // 应该被限制为1
    });

    it('should preserve access count for existing memories', async () => {
      const content = "重复内容测试";
      const metadata = {
        userId: testUserId,
        type: "shortTerm" as const,
        timestamp: Date.now(),
        importance: 0.5
      };

      // 添加第一次
      await memoryStore.addMemory(content, metadata);
      
      // 模拟访问
      await memoryStore.searchMemories({
        text: content,
        filters: { userId: testUserId },
        limit: 1
      });

      // 再次添加相同内容
      await memoryStore.addMemory(content, metadata);

      const userMemories = memoryStore.getUserMemories(testUserId);
      expect(userMemories[0].accessCount).toBeGreaterThan(1);
    });
  });

  describe('searchMemories', () => {
    beforeEach(async () => {
      // 添加测试数据
      const testMemories = [
        { content: "我喜欢吃中国菜", importance: 0.8, type: "longTerm" as const },
        { content: "今天天气很好", importance: 0.3, type: "shortTerm" as const },
        { content: "我的工作是软件开发", importance: 0.9, type: "profile" as const },
        { content: "明天要开会", importance: 0.6, type: "midTerm" as const }
      ];

      for (const memory of testMemories) {
        await memoryStore.addMemory(memory.content, {
          userId: testUserId,
          type: memory.type,
          timestamp: Date.now(),
          importance: memory.importance
        });
      }
    });

    it('should find semantically similar memories', async () => {
      const query: SemanticQuery = {
        text: "饮食偏好",
        filters: { userId: testUserId },
        limit: 5
      };

      const results = await memoryStore.searchMemories(query);

      expect(results).toBeDefined();
      expect(results.length).toBeGreaterThan(0);
      
      // 应该找到与饮食相关的记忆
      const foodRelated = results.find(r => r.vector.content.includes("中国菜"));
      expect(foodRelated).toBeDefined();
    });

    it('should filter by memory type', async () => {
      const query: SemanticQuery = {
        text: "工作",
        filters: { 
          userId: testUserId,
          type: "profile"
        },
        limit: 5
      };

      const results = await memoryStore.searchMemories(query);

      expect(results.every(r => r.vector.metadata.type === "profile")).toBe(true);
    });

    it('should respect similarity threshold', async () => {
      const query: SemanticQuery = {
        text: "完全不相关的内容xyz123",
        filters: { userId: testUserId },
        threshold: 0.8, // 高阈值
        limit: 5
      };

      const results = await memoryStore.searchMemories(query);
      
      // 应该找不到高度相似的内容
      expect(results.length).toBe(0);
    });

    it('should update access statistics', async () => {
      const query: SemanticQuery = {
        text: "工作",
        filters: { userId: testUserId },
        limit: 1
      };

      const resultsBefore = await memoryStore.searchMemories(query);
      const memoryBefore = resultsBefore[0];
      
      if (memoryBefore) {
        const accessCountBefore = memoryBefore.vector.accessCount;
        
        // 再次搜索
        await memoryStore.searchMemories(query);
        
        const userMemories = memoryStore.getUserMemories(testUserId);
        const updatedMemory = userMemories.find(m => m.id === memoryBefore.vector.id);
        
        expect(updatedMemory?.accessCount).toBeGreaterThan(accessCountBefore);
      }
    });

    it('should rank results by composite score', async () => {
      const query: SemanticQuery = {
        text: "重要信息",
        filters: { userId: testUserId },
        limit: 5
      };

      const results = await memoryStore.searchMemories(query);
      
      // 结果应该按排名排序
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i].rank).toBeLessThanOrEqual(results[i + 1].rank);
      }
    });
  });

  describe('removeMemory', () => {
    it('should remove memory and update user index', async () => {
      const content = "要删除的记忆";
      const metadata = {
        userId: testUserId,
        type: "shortTerm" as const,
        timestamp: Date.now(),
        importance: 0.5
      };

      const memoryId = await memoryStore.addMemory(content, metadata);
      
      expect(memoryStore.getUserMemories(testUserId)).toHaveLength(1);
      
      const removed = memoryStore.removeMemory(memoryId);
      
      expect(removed).toBe(true);
      expect(memoryStore.getUserMemories(testUserId)).toHaveLength(0);
    });

    it('should return false for non-existent memory', () => {
      const removed = memoryStore.removeMemory('non-existent-id');
      expect(removed).toBe(false);
    });
  });

  describe('cleanupExpiredMemories', () => {
    beforeEach(async () => {
      // 添加不同重要性和时间的记忆
      const oldTimestamp = Date.now() - 31 * 24 * 60 * 60 * 1000; // 31天前
      
      await memoryStore.addMemory("旧的重要记忆", {
        userId: testUserId,
        type: "longTerm",
        timestamp: oldTimestamp,
        importance: 0.9
      });

      await memoryStore.addMemory("旧的不重要记忆", {
        userId: testUserId,
        type: "shortTerm",
        timestamp: oldTimestamp,
        importance: 0.1
      });

      await memoryStore.addMemory("新的记忆", {
        userId: testUserId,
        type: "shortTerm",
        timestamp: Date.now(),
        importance: 0.5
      });
    });

    it('should remove old low-importance memories', async () => {
      const cleanup = await memoryStore.cleanupExpiredMemories({
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30天
        minImportance: 0.2
      });

      expect(cleanup.removed).toBe(1); // 应该删除旧的不重要记忆
      expect(cleanup.kept).toBe(2); // 保留重要记忆和新记忆
    });

    it('should respect maxVectorsPerUser limit', async () => {
      // 添加更多记忆
      for (let i = 0; i < 5; i++) {
        await memoryStore.addMemory(`额外记忆 ${i}`, {
          userId: testUserId,
          type: "shortTerm",
          timestamp: Date.now(),
          importance: 0.3
        });
      }

      const cleanup = await memoryStore.cleanupExpiredMemories({
        maxVectorsPerUser: 3
      });

      expect(cleanup.kept).toBe(3);
      expect(memoryStore.getUserMemories(testUserId)).toHaveLength(3);
    });

    it('should preserve pinned memories', async () => {
      await memoryStore.addMemory("重要的固定记忆", {
        userId: testUserId,
        type: "pinned",
        timestamp: Date.now() - 100 * 24 * 60 * 60 * 1000, // 很久以前
        importance: 0.1 // 低重要性
      });

      const cleanup = await memoryStore.cleanupExpiredMemories({
        maxAge: 30 * 24 * 60 * 60 * 1000,
        minImportance: 0.5
      });

      const pinnedMemories = memoryStore.getUserMemories(testUserId)
        .filter(m => m.metadata.type === "pinned");
      
      expect(pinnedMemories).toHaveLength(1); // 固定记忆应该保留
    });
  });

  describe('getStatistics', () => {
    beforeEach(async () => {
      const memories = [
        { type: "shortTerm" as const, importance: 0.3 },
        { type: "longTerm" as const, importance: 0.8 },
        { type: "profile" as const, importance: 0.9 }
      ];

      for (const memory of memories) {
        await memoryStore.addMemory(`测试内容 ${memory.type}`, {
          userId: testUserId,
          type: memory.type,
          timestamp: Date.now(),
          importance: memory.importance
        });
      }
    });

    it('should return correct statistics', () => {
      const stats = memoryStore.getStatistics();

      expect(stats.totalVectors).toBe(3);
      expect(stats.userCount).toBe(1);
      expect(stats.typeDistribution).toEqual({
        shortTerm: 1,
        longTerm: 1,
        profile: 1
      });
      expect(stats.averageImportance).toBeCloseTo((0.3 + 0.8 + 0.9) / 3, 2);
    });
  });

  describe('edge cases', () => {
    it('should handle empty search query', async () => {
      const query: SemanticQuery = {
        text: "",
        filters: { userId: testUserId }
      };

      const results = await memoryStore.searchMemories(query);
      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle non-existent user', async () => {
      const memories = memoryStore.getUserMemories("non-existent-user");
      expect(memories).toEqual([]);
    });

    it('should handle very long content', async () => {
      const longContent = "很长的内容".repeat(1000);
      
      const memoryId = await memoryStore.addMemory(longContent, {
        userId: testUserId,
        type: "shortTerm",
        timestamp: Date.now(),
        importance: 0.5
      });

      expect(memoryId).toBeDefined();
      
      const userMemories = memoryStore.getUserMemories(testUserId);
      expect(userMemories[0].content).toBe(longContent);
    });
  });
});