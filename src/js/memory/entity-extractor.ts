/**
 * 实体提取器
 * 从文本中提取实体（规则 + LLM增强）
 */

import { log } from "../shared/logger.js";
import type {
  GraphEntity,
  EntityType,
  EntityExtractionResult
} from "./knowledge-graph-types.js";

/**
 * 生成实体ID
 */
function generateEntityId(): string {
  return `ent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 实体提取选项
 */
export interface EntityExtractionOptions {
  /** 是否使用LLM增强提取 */
  useLLM?: boolean;
  /** 置信度阈值 */
  confidenceThreshold?: number;
  /** 是否自动合并重复实体 */
  autoMerge?: boolean;
}

/**
 * 实体提取模式
 */
interface EntityPattern {
  pattern: RegExp;
  type: EntityType;
  confidence: number;
  extractName: (match: RegExpMatchArray) => string;
  extractProperties?: (match: RegExpMatchArray) => Record<string, unknown>;
}

/**
 * 实体提取器类
 */
export class EntityExtractor {
  private patterns: EntityPattern[] = [];

  constructor() {
    this.initializePatterns();
  }

  /**
   * 初始化提取模式
   */
  private initializePatterns(): void {
    this.patterns = [
      // ========== 人物模式 ==========
      {
        pattern: /我叫([^\s，。,.!?]{2,4})/g,
        type: "PERSON",
        confidence: 0.95,
        extractName: (match) => match[1].trim()
      },
      {
        pattern: /我是([^\s，。,.!?]{2,4})/g,
        type: "PERSON",
        confidence: 0.85,
        extractName: (match) => match[1].trim()
      },
      {
        pattern: /([^\s，。,.!?]{2,4})(?:是我的|是|认识)(?:朋友|同事|同学|老师|学生)/g,
        type: "PERSON",
        confidence: 0.8,
        extractName: (match) => match[1].trim()
      },

      // ========== 组织模式 ==========
      {
        pattern: /在(.+?)(?:公司|团队|组织|部门|小组)(?:工作|就职|任职)/g,
        type: "ORGANIZATION",
        confidence: 0.9,
        extractName: (match) => match[1].trim() + "公司"
      },
      {
        pattern: /(.+?)(?:科技|集团|有限公司|股份|企业|机构)/g,
        type: "ORGANIZATION",
        confidence: 0.85,
        extractName: (match) => match[0].trim()
      },
      {
        pattern: /(?:就职于|供职于|在)(.+?)(?:工作|上班)/g,
        type: "ORGANIZATION",
        confidence: 0.8,
        extractName: (match) => match[1].trim()
      },

      // ========== 地点模式 ==========
      {
        pattern: /(?:在|位于)(.+?)(?:市|区|县|街|路|镇|村)/g,
        type: "LOCATION",
        confidence: 0.9,
        extractName: (match) => match[0].replace(/^(?:在|位于)/, "").trim()
      },
      {
        pattern: /(.+?)(?:位于|坐落在)(.+)/g,
        type: "LOCATION",
        confidence: 0.85,
        extractName: (match) => match[2].trim()
      },

      // ========== 技能模式 ==========
      {
        pattern: /(?:擅长|精通|掌握|会)(.+?)(?:编程|开发|设计|语言|技术)/g,
        type: "SKILL",
        confidence: 0.9,
        extractName: (match) => match[0].replace(/^(?:擅长|精通|掌握|会)/, "").trim()
      },
      {
        pattern: /(?:会|懂|了解)(?:使用)?([A-Za-z]+(?:\.[A-Za-z]+)?)/g,
        type: "SKILL",
        confidence: 0.85,
        extractName: (match) => match[1].trim()
      },

      // ========== 偏好模式 ==========
      {
        pattern: /(?:喜欢|热爱|爱好|偏好)(.+?)(?:[，。,.]|$)/g,
        type: "PREFERENCE",
        confidence: 0.9,
        extractName: (match) => match[1].trim(),
        extractProperties: () => ({ sentiment: "positive" })
      },
      {
        pattern: /(?:不喜欢|讨厌|厌恶)(.+?)(?:[，。,.]|$)/g,
        type: "PREFERENCE",
        confidence: 0.9,
        extractName: (match) => match[1].trim(),
        extractProperties: () => ({ sentiment: "negative" })
      },

      // ========== 概念模式 ==========
      {
        pattern: /(?:学习|研究|了解|关注)(.+?)(?:[，。,.]|$)/g,
        type: "CONCEPT",
        confidence: 0.7,
        extractName: (match) => match[1].trim()
      },

      // ========== 产品模式 ==========
      {
        pattern: /(?:使用|购买|拥有)(.+?)(?:[，。,.]|$)/g,
        type: "PRODUCT",
        confidence: 0.7,
        extractName: (match) => match[1].trim()
      },

      // ========== 事件模式 ==========
      {
        pattern: /(?:参加|参与|组织)(.+?)(?:会议|活动|项目|比赛)/g,
        type: "EVENT",
        confidence: 0.85,
        extractName: (match) => match[0].replace(/^(?:参加|参与|组织)/, "").trim()
      },

      // ========== 时间模式 ==========
      {
        pattern: /(\d{4}年(?:\d{1,2}月)?(?:\d{1,2}日)?)/g,
        type: "TIME",
        confidence: 0.95,
        extractName: (match) => match[1].trim()
      },
      {
        pattern: /((?:今天|明天|昨天|上周|下周|这周|本月|下月|去年|今年|明年))/g,
        type: "TIME",
        confidence: 0.9,
        extractName: (match) => match[1].trim()
      }
    ];
  }

  /**
   * 提取实体（主入口）
   */
  async extractEntities(
    text: string,
    userId: string,
    memoryId: string,
    options: EntityExtractionOptions = {}
  ): Promise<GraphEntity[]> {
    const startTime = Date.now();

    // 规则提取
    const ruleEntities = this.extractByRules(text);

    log("debug", "Rule-based entity extraction completed", {
      text: text.slice(0, 50),
      entityCount: ruleEntities.length
    });

    // LLM增强（可选）
    let llmEntities: EntityExtractionResult[] = [];
    if (options.useLLM) {
      try {
        llmEntities = await this.extractByLLM(text, userId);
        log("debug", "LLM-enhanced entity extraction completed", {
          entityCount: llmEntities.length
        });
      } catch (error) {
        log("warn", "LLM entity extraction failed, using rule-based only", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // 合并去重
    const mergedEntities = this.mergeExtractions(ruleEntities, llmEntities);

    // 过滤低置信度实体
    const threshold = options.confidenceThreshold ?? 0.5;
    const filteredEntities = mergedEntities.filter(e => e.confidence >= threshold);

    // 转换为GraphEntity
    const graphEntities = filteredEntities.map(entity => this.toGraphEntity(
      entity,
      userId,
      memoryId
    ));

    // 自动合并重复实体（基于名称）
    const finalEntities = options.autoMerge
      ? this.mergeDuplicatesByName(graphEntities)
      : graphEntities;

    const duration = Date.now() - startTime;

    log("info", "Entity extraction completed", {
      text: text.slice(0, 50),
      ruleCount: ruleEntities.length,
      llmCount: llmEntities.length,
      mergedCount: mergedEntities.length,
      finalCount: finalEntities.length,
      duration
    });

    return finalEntities;
  }

  /**
   * 规则提取
   */
  private extractByRules(text: string): EntityExtractionResult[] {
    const results: EntityExtractionResult[] = [];
    const seen = new Set<string>();

    for (const patternDef of this.patterns) {
      // 重置正则的lastIndex
      patternDef.pattern.lastIndex = 0;

      let match: RegExpMatchArray | null;
      while ((match = patternDef.pattern.exec(text)) !== null) {
        const name = patternDef.extractName(match);

        // 去除空白和无效名称
        if (!name || name.length < 2 || name.length > 50) {
          continue;
        }

        // 去重
        const key = `${patternDef.type}:${name}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        results.push({
          name,
          type: patternDef.type,
          confidence: patternDef.confidence,
          span: match.index !== undefined
            ? [match.index, match.index + match[0].length]
            : undefined,
          properties: patternDef.extractProperties?.(match) || {}
        });
      }
    }

    return results;
  }

  /**
   * LLM增强提取（可选）
   */
  private async extractByLLM(
    text: string,
    userId: string
  ): Promise<EntityExtractionResult[]> {
    // TODO: 集成PI Agent调用LLM进行实体提取
    // 需要构造prompt，要求LLM返回JSON格式的实体列表

    // 暂时返回空数组，未来实现时可以调用PI Agent
    log("debug", "LLM entity extraction not implemented yet", {
      text: text.slice(0, 50),
      userId
    });

    return [];
  }

  /**
   * 合并提取结果
   */
  private mergeExtractions(
    ruleEntities: EntityExtractionResult[],
    llmEntities: EntityExtractionResult[]
  ): EntityExtractionResult[] {
    const merged = new Map<string, EntityExtractionResult>();

    // 添加规则实体
    for (const entity of ruleEntities) {
      const key = `${entity.type}:${entity.name}`;
      merged.set(key, entity);
    }

    // 合并LLM实体（如果置信度更高则替换）
    for (const entity of llmEntities) {
      const key = `${entity.type}:${entity.name}`;
      const existing = merged.get(key);

      if (!existing || entity.confidence > existing.confidence) {
        merged.set(key, entity);
      } else if (existing) {
        // 合并属性
        existing.properties = {
          ...existing.properties,
          ...entity.properties
        };
        // 取平均置信度
        existing.confidence = (existing.confidence + entity.confidence) / 2;
      }
    }

    return Array.from(merged.values());
  }

  /**
   * 转换为GraphEntity
   */
  private toGraphEntity(
    extraction: EntityExtractionResult,
    userId: string,
    memoryId: string
  ): GraphEntity {
    const now = Date.now();

    return {
      id: generateEntityId(),
      name: extraction.name,
      type: extraction.type,
      properties: extraction.properties || {},
      aliases: [],
      confidence: extraction.confidence,
      source: {
        memoryId,
        timestamp: now
      },
      metadata: {
        userId,
        accessCount: 0,
        lastAccessed: now,
        importance: this.calculateImportance(extraction)
      }
    };
  }

  /**
   * 计算实体重要性
   */
  private calculateImportance(entity: EntityExtractionResult): number {
    // 基础重要性由类型决定
    const typeImportance: Record<EntityType, number> = {
      PERSON: 0.9,
      ORGANIZATION: 0.85,
      SKILL: 0.8,
      PREFERENCE: 0.75,
      LOCATION: 0.7,
      EVENT: 0.7,
      PRODUCT: 0.65,
      CONCEPT: 0.6,
      TIME: 0.5
    };

    let importance = typeImportance[entity.type] || 0.5;

    // 置信度加权
    importance = importance * (0.5 + entity.confidence * 0.5);

    // 归一化到[0, 1]
    return Math.max(0, Math.min(1, importance));
  }

  /**
   * 按名称合并重复实体
   */
  private mergeDuplicatesByName(entities: GraphEntity[]): GraphEntity[] {
    const nameMap = new Map<string, GraphEntity[]>();

    // 按名称分组
    for (const entity of entities) {
      const key = `${entity.type}:${entity.name.toLowerCase()}`;
      if (!nameMap.has(key)) {
        nameMap.set(key, []);
      }
      nameMap.get(key)!.push(entity);
    }

    const merged: GraphEntity[] = [];

    // 合并每组
    for (const group of nameMap.values()) {
      if (group.length === 1) {
        merged.push(group[0]);
      } else {
        // 选择置信度最高的作为主实体
        const primary = group.reduce((max, e) =>
          e.confidence > max.confidence ? e : max
        );

        // 合并别名和属性
        const aliases = new Set<string>();
        const properties: Record<string, unknown> = {};

        for (const entity of group) {
          if (entity.id !== primary.id) {
            aliases.add(entity.name);
          }
          Object.assign(properties, entity.properties);
        }

        primary.aliases = Array.from(aliases);
        primary.properties = { ...primary.properties, ...properties };

        // 取平均置信度
        primary.confidence = group.reduce((sum, e) => sum + e.confidence, 0) / group.length;

        merged.push(primary);
      }
    }

    return merged;
  }

  /**
   * 添加自定义模式
   */
  addPattern(pattern: EntityPattern): void {
    this.patterns.push(pattern);
    log("debug", "Custom entity pattern added", {
      type: pattern.type,
      confidence: pattern.confidence
    });
  }

  /**
   * 获取所有模式
   */
  getPatterns(): EntityPattern[] {
    return [...this.patterns];
  }
}

// 导出单例实例
export const entityExtractor = new EntityExtractor();
