/**
 * 知识图谱类型定义
 * 定义实体、关系、查询等核心数据结构
 */

// ========== 实体类型 ==========

/**
 * 实体类型枚举
 */
export type EntityType =
  | "PERSON"        // 人物: 张三、李明
  | "ORGANIZATION"  // 组织: 明略科技、腾讯
  | "LOCATION"      // 地点: 北京、深圳
  | "EVENT"         // 事件: 项目启动、会议
  | "CONCEPT"       // 概念: 机器学习、推荐系统
  | "PRODUCT"       // 产品: iPhone、ChatGPT
  | "TIME"          // 时间: 2024年、下周
  | "SKILL"         // 技能: Python、架构设计
  | "PREFERENCE";   // 偏好: 喜欢编程、不喜欢加班

// ========== 关系类型 ==========

/**
 * 关系类型枚举
 */
export type RelationType =
  | "WORKS_AT"        // 工作于: 张三 WORKS_AT 腾讯
  | "LOCATED_IN"      // 位于: 腾讯 LOCATED_IN 深圳
  | "KNOWS"           // 认识: 张三 KNOWS 李四
  | "LIKES"           // 喜欢: 张三 LIKES 编程
  | "DISLIKES"        // 不喜欢: 张三 DISLIKES 加班
  | "HAS_SKILL"       // 拥有技能: 张三 HAS_SKILL Python
  | "PARTICIPATED_IN" // 参与: 张三 PARTICIPATED_IN 项目
  | "RELATED_TO"      // 相关: 机器学习 RELATED_TO 推荐系统
  | "OWNS"            // 拥有: 张三 OWNS iPhone
  | "HAPPENED_AT";    // 发生于: 会议 HAPPENED_AT 下周

// ========== 实体定义 ==========

/**
 * 图实体
 */
export interface GraphEntity {
  /** 实体ID (ent_abc123) */
  id: string;

  /** 实体名称 */
  name: string;

  /** 实体类型 */
  type: EntityType;

  /** 扩展属性 */
  properties: Record<string, unknown>;

  /** 别名列表 */
  aliases: string[];

  /** 置信度 (0-1) */
  confidence: number;

  /** 来源信息 */
  source: {
    /** 来源记忆ID */
    memoryId: string;
    /** 创建时间戳 */
    timestamp: number;
  };

  /** 元数据 */
  metadata: {
    /** 用户ID */
    userId: string;
    /** 访问次数 */
    accessCount: number;
    /** 最后访问时间 */
    lastAccessed: number;
    /** 重要性 (0-1) */
    importance: number;
  };
}

// ========== 关系定义 ==========

/**
 * 图关系
 */
export interface GraphRelation {
  /** 关系ID (rel_xyz789) */
  id: string;

  /** 源实体ID */
  sourceId: string;

  /** 目标实体ID */
  targetId: string;

  /** 关系类型 */
  type: RelationType;

  /** 扩展属性 */
  properties: Record<string, unknown>;

  /** 置信度 (0-1) */
  confidence: number;

  /** 时间信息 */
  temporal: {
    /** 关系开始时间 (可选) */
    startTime?: number;
    /** 关系结束时间 (可选) */
    endTime?: number;
    /** 记录时间戳 */
    timestamp: number;
  };

  /** 来源信息 */
  source: {
    /** 来源记忆ID */
    memoryId: string;
    /** 用户ID */
    userId: string;
  };
}

// ========== 提取结果 ==========

/**
 * 实体提取结果
 */
export interface EntityExtractionResult {
  /** 实体名称 */
  name: string;

  /** 实体类型 */
  type: EntityType;

  /** 置信度 (0-1) */
  confidence: number;

  /** 在文本中的位置 [start, end] */
  span?: [number, number];

  /** 扩展属性 */
  properties?: Record<string, unknown>;
}

/**
 * 关系提取结果
 */
export interface RelationExtractionResult {
  /** 源实体名称 */
  sourceName: string;

  /** 目标实体名称 */
  targetName: string;

  /** 关系类型 */
  type: RelationType;

  /** 置信度 (0-1) */
  confidence: number;

  /** 扩展属性 */
  properties?: Record<string, unknown>;
}

// ========== 图查询 ==========

/**
 * 图路径
 */
export interface GraphPath {
  /** 路径上的实体列表 */
  entities: GraphEntity[];

  /** 路径上的关系列表 */
  relations: GraphRelation[];

  /** 路径长度（跳数） */
  distance: number;

  /** 路径相关性分数 */
  score: number;
}

/**
 * 图查询结果
 */
export interface GraphQueryResult {
  /** 匹配的实体 */
  entities: GraphEntity[];

  /** 匹配的关系 */
  relations: GraphRelation[];

  /** 路径结果（用于路径查询） */
  paths?: GraphPath[];

  /** 查询元数据 */
  metadata: {
    /** 查询耗时 (ms) */
    queryTime: number;
    /** 结果数量 */
    resultCount: number;
    /** 是否来自缓存 */
    fromCache: boolean;
  };
}

/**
 * 实体查询过滤器
 */
export interface EntityQueryFilter {
  /** 用户ID */
  userId: string;

  /** 实体名称 (精确匹配或模糊匹配) */
  name?: string;

  /** 实体类型 */
  type?: EntityType;

  /** 最小置信度 */
  minConfidence?: number;

  /** 最小重要性 */
  minImportance?: number;

  /** 结果数量限制 */
  limit?: number;
}

/**
 * 关系查询过滤器
 */
export interface RelationQueryFilter {
  /** 用户ID */
  userId: string;

  /** 源实体ID */
  sourceId?: string;

  /** 目标实体ID */
  targetId?: string;

  /** 关系类型 */
  type?: RelationType;

  /** 最小置信度 */
  minConfidence?: number;

  /** 结果数量限制 */
  limit?: number;
}

// ========== 统计信息 ==========

/**
 * 图统计信息
 */
export interface GraphStatistics {
  /** 实体总数 */
  entityCount: number;

  /** 关系总数 */
  relationCount: number;

  /** 按实体类型统计 */
  byEntityType: Partial<Record<EntityType, number>>;

  /** 按关系类型统计 */
  byRelationType: Partial<Record<RelationType, number>>;

  /** 平均实体置信度 */
  avgEntityConfidence?: number;

  /** 平均关系置信度 */
  avgRelationConfidence?: number;
}

// ========== 图操作选项 ==========

/**
 * 图提取选项
 */
export interface GraphExtractionOptions {
  /** 是否使用LLM增强提取 */
  useLLM?: boolean;

  /** 是否自动合并重复实体 */
  autoMerge?: boolean;

  /** 实体置信度阈值 */
  entityThreshold?: number;

  /** 关系置信度阈值 */
  relationThreshold?: number;
}

/**
 * 图遍历方向
 */
export type GraphDirection = "out" | "in" | "both";

/**
 * 邻居查询结果
 */
export interface NeighborQueryResult {
  /** 邻居实体列表 */
  entities: GraphEntity[];

  /** 连接关系列表 */
  relations: GraphRelation[];
}

/**
 * 子图查询结果
 */
export interface SubgraphQueryResult {
  /** 子图中的实体 */
  entities: GraphEntity[];

  /** 子图中的关系 */
  relations: GraphRelation[];

  /** 中心实体ID */
  centerEntityId: string;

  /** 子图半径 */
  radius: number;
}
