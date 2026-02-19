/**
 * 内存图索引
 * 加速图遍历查询
 */

import { log } from "../shared/logger.js";
import type {
  GraphEntity,
  GraphRelation,
  EntityType,
  RelationType,
  GraphPath,
  GraphDirection,
  NeighborQueryResult,
  SubgraphQueryResult
} from "./knowledge-graph-types.js";

/**
 * 邻接表节点
 */
interface AdjacencyNode {
  outgoing: Map<string, GraphRelation[]>;  // targetId -> relations
  incoming: Map<string, GraphRelation[]>;  // sourceId -> relations
}

/**
 * 内存图索引类
 */
export class GraphIndex {
  // 邻接表
  private adjacencyList = new Map<string, AdjacencyNode>();

  // 实体索引
  private entities = new Map<string, GraphEntity>();
  private entityNameIndex = new Map<string, Set<string>>();
  private entityTypeIndex = new Map<EntityType, Set<string>>();

  // 关系索引
  private relations = new Map<string, GraphRelation>();
  private relationTypeIndex = new Map<RelationType, Set<string>>();

  // 路径缓存
  private pathCache = new Map<string, GraphPath[]>();
  private cacheHits = 0;
  private cacheMisses = 0;

  /**
   * 从数据库构建索引
   */
  buildIndex(entities: GraphEntity[], relations: GraphRelation[]): void {
    const startTime = Date.now();

    // 清空现有索引
    this.clear();

    // 索引实体
    for (const entity of entities) {
      this.addEntity(entity);
    }

    // 索引关系
    for (const relation of relations) {
      this.addRelation(relation);
    }

    const duration = Date.now() - startTime;
    log("info", "Graph index built", {
      entityCount: entities.length,
      relationCount: relations.length,
      durationMs: duration
    });
  }

  /**
   * 添加实体到索引
   */
  addEntity(entity: GraphEntity): void {
    this.entities.set(entity.id, entity);

    // 名称索引
    if (!this.entityNameIndex.has(entity.name)) {
      this.entityNameIndex.set(entity.name, new Set());
    }
    this.entityNameIndex.get(entity.name)!.add(entity.id);

    // 类型索引
    if (!this.entityTypeIndex.has(entity.type)) {
      this.entityTypeIndex.set(entity.type, new Set());
    }
    this.entityTypeIndex.get(entity.type)!.add(entity.id);

    // 初始化邻接表
    if (!this.adjacencyList.has(entity.id)) {
      this.adjacencyList.set(entity.id, {
        outgoing: new Map(),
        incoming: new Map()
      });
    }
  }

  /**
   * 添加关系到索引
   */
  addRelation(relation: GraphRelation): void {
    this.relations.set(relation.id, relation);

    // 类型索引
    if (!this.relationTypeIndex.has(relation.type)) {
      this.relationTypeIndex.set(relation.type, new Set());
    }
    this.relationTypeIndex.get(relation.type)!.add(relation.id);

    // 更新邻接表
    const sourceAdj = this.adjacencyList.get(relation.sourceId);
    const targetAdj = this.adjacencyList.get(relation.targetId);

    if (sourceAdj) {
      if (!sourceAdj.outgoing.has(relation.targetId)) {
        sourceAdj.outgoing.set(relation.targetId, []);
      }
      sourceAdj.outgoing.get(relation.targetId)!.push(relation);
    }

    if (targetAdj) {
      if (!targetAdj.incoming.has(relation.sourceId)) {
        targetAdj.incoming.set(relation.sourceId, []);
      }
      targetAdj.incoming.get(relation.sourceId)!.push(relation);
    }

    // 清除路径缓存
    this.pathCache.clear();
  }

  /**
   * 移除实体
   */
  removeEntity(entityId: string): void {
    const entity = this.entities.get(entityId);
    if (!entity) return;

    this.entities.delete(entityId);

    // 移除名称索引
    const nameSet = this.entityNameIndex.get(entity.name);
    if (nameSet) {
      nameSet.delete(entityId);
      if (nameSet.size === 0) {
        this.entityNameIndex.delete(entity.name);
      }
    }

    // 移除类型索引
    const typeSet = this.entityTypeIndex.get(entity.type);
    if (typeSet) {
      typeSet.delete(entityId);
      if (typeSet.size === 0) {
        this.entityTypeIndex.delete(entity.type);
      }
    }

    // 移除邻接表
    this.adjacencyList.delete(entityId);

    // 清除缓存
    this.pathCache.clear();
  }

  /**
   * 移除关系
   */
  removeRelation(relationId: string): void {
    const relation = this.relations.get(relationId);
    if (!relation) return;

    this.relations.delete(relationId);

    // 移除类型索引
    const typeSet = this.relationTypeIndex.get(relation.type);
    if (typeSet) {
      typeSet.delete(relationId);
      if (typeSet.size === 0) {
        this.relationTypeIndex.delete(relation.type);
      }
    }

    // 更新邻接表
    const sourceAdj = this.adjacencyList.get(relation.sourceId);
    if (sourceAdj) {
      const outgoing = sourceAdj.outgoing.get(relation.targetId);
      if (outgoing) {
        const index = outgoing.findIndex(r => r.id === relationId);
        if (index >= 0) outgoing.splice(index, 1);
      }
    }

    const targetAdj = this.adjacencyList.get(relation.targetId);
    if (targetAdj) {
      const incoming = targetAdj.incoming.get(relation.sourceId);
      if (incoming) {
        const index = incoming.findIndex(r => r.id === relationId);
        if (index >= 0) incoming.splice(index, 1);
      }
    }

    this.pathCache.clear();
  }

  /**
   * 获取邻居节点
   */
  getNeighbors(entityId: string, direction: GraphDirection = "both"): NeighborQueryResult {
    const adj = this.adjacencyList.get(entityId);
    if (!adj) {
      return { entities: [], relations: [] };
    }

    const neighborIds = new Set<string>();
    const relations: GraphRelation[] = [];

    if (direction === "out" || direction === "both") {
      for (const [targetId, rels] of adj.outgoing) {
        neighborIds.add(targetId);
        relations.push(...rels);
      }
    }

    if (direction === "in" || direction === "both") {
      for (const [sourceId, rels] of adj.incoming) {
        neighborIds.add(sourceId);
        relations.push(...rels);
      }
    }

    const entities = Array.from(neighborIds)
      .map(id => this.entities.get(id))
      .filter(Boolean) as GraphEntity[];

    return { entities, relations };
  }

  /**
   * BFS查找最短路径
   */
  findPaths(
    sourceId: string,
    targetId: string,
    maxDepth: number = 3
  ): GraphPath[] {
    // 检查缓存
    const cacheKey = `${sourceId}:${targetId}:${maxDepth}`;
    const cached = this.pathCache.get(cacheKey);
    if (cached) {
      this.cacheHits++;
      return cached;
    }
    this.cacheMisses++;

    const paths: GraphPath[] = [];
    const queue: Array<{
      currentId: string;
      path: string[];
      relations: GraphRelation[];
      depth: number;
    }> = [{ currentId: sourceId, path: [sourceId], relations: [], depth: 0 }];

    const visited = new Set<string>();

    while (queue.length > 0) {
      const { currentId, path, relations, depth } = queue.shift()!;

      if (depth > maxDepth) continue;

      if (currentId === targetId && depth > 0) {
        // 找到路径
        const entities = path
          .map(id => this.entities.get(id))
          .filter(Boolean) as GraphEntity[];

        paths.push({
          entities,
          relations: [...relations],
          distance: depth,
          score: this.calculatePathScore(entities, relations)
        });

        continue;
      }

      const pathKey = path.join("->");
      if (visited.has(pathKey)) continue;
      visited.add(pathKey);

      const adj = this.adjacencyList.get(currentId);
      if (!adj) continue;

      // 探索出边
      for (const [neighborId, rels] of adj.outgoing) {
        if (path.includes(neighborId)) continue; // 避免环路

        for (const rel of rels) {
          queue.push({
            currentId: neighborId,
            path: [...path, neighborId],
            relations: [...relations, rel],
            depth: depth + 1
          });
        }
      }
    }

    // 按分数排序
    paths.sort((a, b) => b.score - a.score);

    // 缓存结果
    this.pathCache.set(cacheKey, paths);

    return paths;
  }

  /**
   * 提取子图
   */
  extractSubgraph(centerEntityId: string, radius: number = 2): SubgraphQueryResult {
    const entityIds = new Set<string>([centerEntityId]);
    const relationIds = new Set<string>();

    // BFS扩展
    let currentLayer = [centerEntityId];

    for (let r = 0; r < radius; r++) {
      const nextLayer: string[] = [];

      for (const entityId of currentLayer) {
        const neighbors = this.getNeighbors(entityId);

        for (const entity of neighbors.entities) {
          if (!entityIds.has(entity.id)) {
            entityIds.add(entity.id);
            nextLayer.push(entity.id);
          }
        }

        for (const relation of neighbors.relations) {
          relationIds.add(relation.id);
        }
      }

      currentLayer = nextLayer;
    }

    const entities = Array.from(entityIds)
      .map(id => this.entities.get(id))
      .filter(Boolean) as GraphEntity[];

    const relations = Array.from(relationIds)
      .map(id => this.relations.get(id))
      .filter(Boolean) as GraphRelation[];

    return { entities, relations, centerEntityId, radius };
  }

  /**
   * 按名称查找实体
   */
  findEntitiesByName(name: string): GraphEntity[] {
    const ids = this.entityNameIndex.get(name);
    if (!ids) return [];

    return Array.from(ids)
      .map(id => this.entities.get(id))
      .filter(Boolean) as GraphEntity[];
  }

  /**
   * 按类型查找实体
   */
  findEntitiesByType(type: EntityType): GraphEntity[] {
    const ids = this.entityTypeIndex.get(type);
    if (!ids) return [];

    return Array.from(ids)
      .map(id => this.entities.get(id))
      .filter(Boolean) as GraphEntity[];
  }

  /**
   * 获取实体
   */
  getEntity(id: string): GraphEntity | undefined {
    return this.entities.get(id);
  }

  /**
   * 获取关系
   */
  getRelation(id: string): GraphRelation | undefined {
    return this.relations.get(id);
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    entityCount: number;
    relationCount: number;
    cacheHitRate: number;
    indexSize: number;
  } {
    const totalCacheRequests = this.cacheHits + this.cacheMisses;
    const cacheHitRate = totalCacheRequests > 0
      ? this.cacheHits / totalCacheRequests
      : 0;

    return {
      entityCount: this.entities.size,
      relationCount: this.relations.size,
      cacheHitRate,
      indexSize: this.adjacencyList.size
    };
  }

  /**
   * 清空索引
   */
  clear(): void {
    this.adjacencyList.clear();
    this.entities.clear();
    this.entityNameIndex.clear();
    this.entityTypeIndex.clear();
    this.relations.clear();
    this.relationTypeIndex.clear();
    this.pathCache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  // ========== 内部辅助方法 ==========

  private calculatePathScore(entities: GraphEntity[], relations: GraphRelation[]): number {
    if (entities.length === 0 || relations.length === 0) return 0;

    // 路径分数 = 平均实体重要性 * 平均关系置信度 / 路径长度
    const avgEntityImportance = entities.reduce((sum, e) => sum + e.metadata.importance, 0) / entities.length;
    const avgRelationConfidence = relations.reduce((sum, r) => sum + r.confidence, 0) / relations.length;
    const lengthPenalty = 1 / (1 + relations.length);

    return avgEntityImportance * avgRelationConfidence * lengthPenalty;
  }
}

export const graphIndex = new GraphIndex();
