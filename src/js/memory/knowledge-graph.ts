/**
 * 知识图谱管理器
 * 协调实体提取、关系提取、图存储和图查询
 */

import { log, logError } from "../shared/logger.js";
import { JPClawError, ErrorCode } from "../shared/errors.js";
import { GraphStore, graphStore } from "./graph-store.js";
import { GraphIndex, graphIndex } from "./graph-index.js";
import { EntityExtractor, entityExtractor } from "./entity-extractor.js";
import { RelationExtractor, relationExtractor } from "./relation-extractor.js";
import type {
  GraphEntity,
  GraphRelation,
  EntityType,
  RelationType,
  GraphPath,
  GraphDirection,
  NeighborQueryResult,
  SubgraphQueryResult,
  EntityQueryFilter,
  RelationQueryFilter,
  GraphStatistics,
  GraphExtractionOptions
} from "./knowledge-graph-types.js";

/**
 * 图谱提取结果
 */
export interface GraphExtractionResult {
  entities: GraphEntity[];
  relations: GraphRelation[];
}

/**
 * 知识图谱管理器类
 */
export class KnowledgeGraph {
  private store: GraphStore;
  private index: GraphIndex;
  private entityExtractor: EntityExtractor;
  private relationExtractor: RelationExtractor;
  private initialized = false;

  constructor() {
    this.store = graphStore;
    this.index = graphIndex;
    this.entityExtractor = entityExtractor;
    this.relationExtractor = relationExtractor;
  }

  /**
   * 初始化知识图谱
   */
  async initialize(userId?: string): Promise<void> {
    if (this.initialized) return;

    try {
      const startTime = Date.now();

      // 初始化存储层
      await this.store.initialize();

      // 如果指定了userId，构建索引
      if (userId) {
        await this.rebuildIndex(userId);
      }

      this.initialized = true;

      const duration = Date.now() - startTime;
      log("info", "Knowledge graph initialized", { duration });

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to initialize knowledge graph",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 从记忆文本中提取图谱
   */
  async extractFromMemory(
    text: string,
    userId: string,
    memoryId: string,
    options: GraphExtractionOptions = {}
  ): Promise<GraphExtractionResult> {
    await this.initialize();

    const startTime = Date.now();

    try {
      // 1. 提取实体
      const entities = await this.entityExtractor.extractEntities(
        text,
        userId,
        memoryId,
        {
          useLLM: options.useLLM,
          confidenceThreshold: options.entityThreshold,
          autoMerge: options.autoMerge
        }
      );

      log("debug", "Entities extracted from memory", {
        memoryId,
        entityCount: entities.length
      });

      // 2. 实体消歧（查找已有同名实体）
      const disambiguatedEntities: GraphEntity[] = [];

      for (const entity of entities) {
        const existing = await this.store.findEntitiesByName(entity.name, userId);

        if (existing.length > 0) {
          // 找到同名实体，合并
          const merged = this.mergeEntity(entity, existing[0]);
          disambiguatedEntities.push(merged);

          log("debug", "Entity merged with existing", {
            name: entity.name,
            existingId: existing[0].id,
            newConfidence: merged.confidence
          });
        } else {
          // 新实体
          disambiguatedEntities.push(entity);
        }
      }

      // 3. 保存实体到数据库
      for (const entity of disambiguatedEntities) {
        await this.store.addEntity(entity);
        this.index.addEntity(entity);
      }

      // 4. 提取关系
      const relations = await this.relationExtractor.extractRelations(
        text,
        disambiguatedEntities,
        userId,
        memoryId,
        {
          useLLM: options.useLLM,
          confidenceThreshold: options.relationThreshold
        }
      );

      log("debug", "Relations extracted from memory", {
        memoryId,
        relationCount: relations.length
      });

      // 5. 保存关系到数据库
      for (const relation of relations) {
        await this.store.addRelation(relation);
        this.index.addRelation(relation);
      }

      const duration = Date.now() - startTime;

      log("info", "Graph extraction completed", {
        memoryId,
        entityCount: disambiguatedEntities.length,
        relationCount: relations.length,
        duration
      });

      return {
        entities: disambiguatedEntities,
        relations
      };

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to extract graph from memory",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 查询实体
   */
  async queryEntities(filter: EntityQueryFilter): Promise<GraphEntity[]> {
    await this.initialize();

    try {
      // 优先使用内存索引查询
      if (filter.name && !filter.minConfidence && !filter.minImportance) {
        const results = this.index.findEntitiesByName(filter.name);
        if (results.length > 0) {
          return filter.limit ? results.slice(0, filter.limit) : results;
        }
      }

      if (filter.type && !filter.name && !filter.minConfidence && !filter.minImportance) {
        const results = this.index.findEntitiesByType(filter.type);
        if (results.length > 0) {
          return filter.limit ? results.slice(0, filter.limit) : results;
        }
      }

      // 回退到数据库查询
      return await this.store.queryEntities(filter);

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to query entities",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 查询关系
   */
  async queryRelations(filter: RelationQueryFilter): Promise<GraphRelation[]> {
    await this.initialize();

    try {
      return await this.store.queryRelations(filter);
    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to query relations",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 获取邻居节点
   */
  async getNeighbors(
    entityId: string,
    direction: GraphDirection = "both"
  ): Promise<NeighborQueryResult> {
    await this.initialize();

    try {
      // 使用内存索引进行快速查询
      return this.index.getNeighbors(entityId, direction);
    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to get neighbors",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 查找路径
   */
  async findPaths(
    sourceId: string,
    targetId: string,
    maxDepth: number = 3
  ): Promise<GraphPath[]> {
    await this.initialize();

    try {
      // 使用内存索引的BFS算法
      return this.index.findPaths(sourceId, targetId, maxDepth);
    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to find paths",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 提取子图
   */
  async extractSubgraph(
    centerEntityId: string,
    radius: number = 2
  ): Promise<SubgraphQueryResult> {
    await this.initialize();

    try {
      // 使用内存索引进行子图提取
      return this.index.extractSubgraph(centerEntityId, radius);
    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to extract subgraph",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 合并实体
   */
  async mergeEntities(entityIds: string[]): Promise<string> {
    await this.initialize();

    if (entityIds.length < 2) {
      throw new Error("Need at least 2 entities to merge");
    }

    try {
      const startTime = Date.now();

      // 1. 获取所有实体
      const entities: GraphEntity[] = [];
      for (const id of entityIds) {
        const entity = await this.store.getEntity(id);
        if (entity) {
          entities.push(entity);
        }
      }

      if (entities.length < 2) {
        throw new Error("Not enough valid entities to merge");
      }

      // 2. 选择置信度最高的作为主实体
      const primary = entities.reduce((max, e) =>
        e.confidence > max.confidence ? e : max
      );

      // 3. 合并别名和属性
      const aliases = new Set<string>(primary.aliases);
      const properties = { ...primary.properties };

      for (const entity of entities) {
        if (entity.id !== primary.id) {
          aliases.add(entity.name);
          Object.assign(properties, entity.properties);
        }
      }

      primary.aliases = Array.from(aliases);
      primary.properties = properties;

      // 取平均置信度
      primary.confidence = entities.reduce((sum, e) => sum + e.confidence, 0) / entities.length;

      // 更新重要性
      primary.metadata.importance = Math.max(
        ...entities.map(e => e.metadata.importance)
      );

      // 4. 更新数据库
      await this.store.addEntity(primary);

      // 5. 更新关系（将指向其他实体的关系重定向到主实体）
      for (const entity of entities) {
        if (entity.id === primary.id) continue;

        // 获取该实体的所有关系
        const outgoing = await this.store.findRelationsByEntity(entity.id, "out");
        const incoming = await this.store.findRelationsByEntity(entity.id, "in");

        // 重定向出边
        for (const rel of outgoing) {
          const newRel = { ...rel, sourceId: primary.id };
          await this.store.addRelation(newRel);
          await this.store.deleteRelation(rel.id);
        }

        // 重定向入边
        for (const rel of incoming) {
          const newRel = { ...rel, targetId: primary.id };
          await this.store.addRelation(newRel);
          await this.store.deleteRelation(rel.id);
        }

        // 删除旧实体
        await this.store.deleteEntity(entity.id);
        this.index.removeEntity(entity.id);
      }

      // 6. 更新索引
      this.index.addEntity(primary);

      const duration = Date.now() - startTime;

      log("info", "Entities merged", {
        primaryId: primary.id,
        mergedCount: entities.length,
        duration
      });

      return primary.id;

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to merge entities",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 获取统计信息
   */
  async getStatistics(userId: string): Promise<GraphStatistics> {
    await this.initialize();

    try {
      // 从数据库获取统计信息
      const dbStats = await this.store.getStatistics(userId);

      // 从索引获取缓存统计
      const indexStats = this.index.getStats();

      return {
        ...dbStats,
        avgEntityConfidence: undefined,  // TODO: 计算平均值
        avgRelationConfidence: undefined
      };

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to get statistics",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 重建内存索引
   */
  async rebuildIndex(userId: string): Promise<void> {
    await this.initialize();

    try {
      const startTime = Date.now();

      // 从数据库加载所有实体和关系
      const entities = await this.store.getAllEntities(userId);
      const relations = await this.store.getAllRelations(userId);

      // 构建索引
      this.index.buildIndex(entities, relations);

      const duration = Date.now() - startTime;

      log("info", "Graph index rebuilt", {
        userId,
        entityCount: entities.length,
        relationCount: relations.length,
        duration
      });

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to rebuild index",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 获取实体
   */
  async getEntity(id: string): Promise<GraphEntity | null> {
    await this.initialize();

    try {
      // 优先从索引查询
      const entity = this.index.getEntity(id);
      if (entity) return entity;

      // 回退到数据库查询
      return await this.store.getEntity(id);

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to get entity",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 获取关系
   */
  async getRelation(id: string): Promise<GraphRelation | null> {
    await this.initialize();

    try {
      // 优先从索引查询
      const relation = this.index.getRelation(id);
      if (relation) return relation;

      // 回退到数据库查询
      return await this.store.getRelation(id);

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to get relation",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 删除实体
   */
  async deleteEntity(id: string): Promise<boolean> {
    await this.initialize();

    try {
      const result = await this.store.deleteEntity(id);
      if (result) {
        this.index.removeEntity(id);
      }
      return result;

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to delete entity",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 删除关系
   */
  async deleteRelation(id: string): Promise<boolean> {
    await this.initialize();

    try {
      const result = await this.store.deleteRelation(id);
      if (result) {
        this.index.removeRelation(id);
      }
      return result;

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to delete relation",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  // ========== 内部辅助方法 ==========

  /**
   * 合并实体（内部使用）
   */
  private mergeEntity(newEntity: GraphEntity, existingEntity: GraphEntity): GraphEntity {
    // 保留现有实体ID
    const merged = { ...existingEntity };

    // 更新置信度（取较高值）
    merged.confidence = Math.max(newEntity.confidence, existingEntity.confidence);

    // 合并别名
    const aliases = new Set([...existingEntity.aliases, newEntity.name]);
    merged.aliases = Array.from(aliases);

    // 合并属性
    merged.properties = {
      ...existingEntity.properties,
      ...newEntity.properties
    };

    // 更新访问次数
    merged.metadata.accessCount += 1;
    merged.metadata.lastAccessed = Date.now();

    // 更新重要性（取较高值）
    merged.metadata.importance = Math.max(
      newEntity.metadata.importance,
      existingEntity.metadata.importance
    );

    return merged;
  }
}

// 导出单例实例
export const knowledgeGraph = new KnowledgeGraph();
