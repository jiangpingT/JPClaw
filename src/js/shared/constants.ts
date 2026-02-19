/**
 * 系统常量定义
 * 集中管理所有魔法数字，提供清晰的文档说明
 */

/**
 * 记忆系统常量
 */
export const MEMORY_CONSTANTS = {
  /**
   * 向量检索相关
   */
  VECTOR: {
    /** 默认相似度阈值 - 低于此值的结果将被过滤 */
    DEFAULT_SIMILARITY_THRESHOLD: 0.05,

    /** 默认最大结果数 */
    DEFAULT_MAX_RESULTS: 10,

    /** 默认记忆最大年龄（毫秒） - 30天 */
    DEFAULT_MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000,

    /** 时间衰减半衰期（天） - 30天后重要性降低到一半 */
    TIME_DECAY_HALFLIFE_DAYS: 30,

    /** 访问次数归一化基准 - 访问10次算作重要 */
    ACCESS_COUNT_NORMALIZATION_BASE: 10,

    /** 最小重要性阈值 - 低于此值会被清理 */
    MIN_IMPORTANCE_THRESHOLD: 0.1,

    /** 默认每用户最大向量数 */
    DEFAULT_MAX_VECTORS_PER_USER: 1000,

    /** P1-NEW-4修复: 淘汰评分中重要性权重 */
    EVICTION_IMPORTANCE_WEIGHT: 0.7,

    /** P1-NEW-4修复: 淘汰评分中访问新近度权重 */
    EVICTION_RECENCY_WEIGHT: 0.3,
  },

  /**
   * 混合检索权重
   */
  HYBRID_SEARCH: {
    /** 向量检索权重 */
    VECTOR_WEIGHT: 0.7,

    /** BM25检索权重 */
    BM25_WEIGHT: 0.3,

    /** 确保权重和为1.0 */
    get TOTAL_WEIGHT() {
      return this.VECTOR_WEIGHT + this.BM25_WEIGHT;
    },
  },

  /**
   * 记忆类型权重（用于排序）
   */
  MEMORY_TYPE_WEIGHTS: {
    pinned: 1.2,      // 置顶记忆最重要
    profile: 1.1,     // 用户画像次之
    longTerm: 1.0,    // 长期记忆标准权重
    midTerm: 0.9,     // 中期记忆略低
    shortTerm: 0.8,   // 短期记忆最低
  },

  /**
   * 压缩和合并
   */
  COMPRESSION: {
    /** 复合分数计算中时间衰减的权重 */
    TIME_DECAY_WEIGHT: 0.3,

    /** 复合分数计算中原始分数的权重 */
    BASE_SCORE_WEIGHT: 0.7,

    /** 时间衰减计算中的时间窗口（毫秒） - 7天 */
    TIME_DECAY_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,
  },

  /**
   * 冲突检测
   */
  CONFLICT: {
    /** 语义相似度阈值 - 超过此值认为可能冲突 */
    SEMANTIC_SIMILARITY_THRESHOLD: 0.85,

    /** 时间窗口（毫秒） - 7天内的记忆才检测冲突 */
    TIME_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,
  },
};

/**
 * 性能常量
 */
export const PERFORMANCE_CONSTANTS = {
  /**
   * 缓存相关
   */
  CACHE: {
    /** BM25缓存最大条目数 */
    BM25_MAX_ENTRIES: 1000,

    /** Topic缓存最大大小 */
    TOPIC_MAX_SIZE: 10000,

    /** 缓存过期时间（毫秒） - 1小时 */
    DEFAULT_TTL_MS: 60 * 60 * 1000,
  },

  /**
   * 批处理
   */
  BATCH: {
    /** 向量操作批处理大小 */
    VECTOR_BATCH_SIZE: 100,

    /** 最大并发请求数 */
    MAX_CONCURRENT_OPERATIONS: 10,
  },
};

/**
 * 安全常量
 */
export const SECURITY_CONSTANTS = {
  /**
   * 速率限制
   */
  RATE_LIMIT: {
    /** 默认时间窗口（毫秒） - 15分钟 */
    DEFAULT_WINDOW_MS: 15 * 60 * 1000,

    /** 默认最大请求数 */
    DEFAULT_MAX_REQUESTS: 100,
  },

  /**
   * 资源限制
   */
  RESOURCE: {
    /** 默认请求体最大大小（字节） - 10MB */
    DEFAULT_MAX_BODY_SIZE: 10 * 1024 * 1024,

    /** 默认最大并发请求数 */
    DEFAULT_MAX_CONCURRENT: 100,

    /** 默认请求超时（毫秒） - 30秒 */
    DEFAULT_TIMEOUT_MS: 30 * 1000,
  },

  /**
   * 会话
   */
  SESSION: {
    /** 默认会话最大持续时间（毫秒） - 24小时 */
    DEFAULT_MAX_DURATION_MS: 24 * 60 * 60 * 1000,
  },
};

/**
 * 定时器常量
 */
export const TIMER_CONSTANTS = {
  /**
   * 清理间隔
   */
  CLEANUP: {
    /** 速率限制清理间隔（毫秒） - 1分钟 */
    RATE_LIMIT_INTERVAL_MS: 60 * 1000,

    /** 向量保存延迟（毫秒） - 10秒 */
    VECTOR_SAVE_DELAY_MS: 10 * 1000,

    /** 健康检查间隔（毫秒） - 2分钟 */
    HEALTH_CHECK_INTERVAL_MS: 2 * 60 * 1000,
  },
};

/**
 * 百分位计算常量
 */
export const PERCENTILE_CONSTANTS = {
  /** 线性插值的小数位数 */
  INTERPOLATION_PRECISION: 10,
};

/**
 * 辅助函数：将毫秒转换为天
 */
export function msTodays(ms: number): number {
  return ms / (24 * 60 * 60 * 1000);
}

/**
 * 辅助函数：将天转换为毫秒
 */
export function daysToMs(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

/**
 * 辅助函数：计算时间衰减因子
 * @param ageMs 年龄（毫秒）
 * @param halflifeDays 半衰期（天）
 */
export function calculateTimeDecay(ageMs: number, halflifeDays: number = MEMORY_CONSTANTS.VECTOR.TIME_DECAY_HALFLIFE_DAYS): number {
  const ageDays = msTodays(ageMs);
  return Math.exp(-ageDays / halflifeDays);
}
