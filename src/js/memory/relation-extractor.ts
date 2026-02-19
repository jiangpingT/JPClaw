/**
 * 关系提取器
 * 从文本中提取实体间的关系（规则 + LLM增强）
 */

import { log } from "../shared/logger.js";
import type {
  GraphEntity,
  GraphRelation,
  RelationType,
  RelationExtractionResult
} from "./knowledge-graph-types.js";

/**
 * 生成关系ID
 */
function generateRelationId(): string {
  return `rel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 关系提取选项
 */
export interface RelationExtractionOptions {
  /** 是否使用LLM增强提取 */
  useLLM?: boolean;
  /** 置信度阈值 */
  confidenceThreshold?: number;
}

/**
 * 关系模式
 */
interface RelationPattern {
  pattern: RegExp;
  type: RelationType;
  confidence: number;
  sourceType?: string;  // 期望的源实体类型
  targetType?: string;  // 期望的目标实体类型
  extractSource: (match: RegExpMatchArray) => string;
  extractTarget: (match: RegExpMatchArray) => string;
  extractProperties?: (match: RegExpMatchArray) => Record<string, unknown>;
}

/**
 * 关系提取器类
 */
export class RelationExtractor {
  private patterns: RelationPattern[] = [];

  constructor() {
    this.initializePatterns();
  }

  /**
   * 初始化关系模式
   */
  private initializePatterns(): void {
    this.patterns = [
      // ========== WORKS_AT（工作于） ==========
      {
        pattern: /(.+?)(?:在|就职于|供职于)(.+?)(?:公司|团队|组织|部门)(?:工作|就职|任职)/g,
        type: "WORKS_AT",
        confidence: 0.9,
        sourceType: "PERSON",
        targetType: "ORGANIZATION",
        extractSource: (match) => match[1].trim(),
        extractTarget: (match) => match[2].trim() + "公司"
      },

      // ========== LOCATED_IN（位于） ==========
      {
        pattern: /(.+?)(?:位于|坐落在|在)(.+?)(?:市|区|县|街|路)/g,
        type: "LOCATED_IN",
        confidence: 0.85,
        targetType: "LOCATION",
        extractSource: (match) => match[1].trim(),
        extractTarget: (match) => match[2].trim()
      },

      // ========== KNOWS（认识） ==========
      {
        pattern: /(.+?)(?:认识|知道)(.+)/g,
        type: "KNOWS",
        confidence: 0.8,
        sourceType: "PERSON",
        targetType: "PERSON",
        extractSource: (match) => match[1].trim(),
        extractTarget: (match) => match[2].trim()
      },
      {
        pattern: /(.+?)(?:是我的|是)(?:朋友|同事|同学|老师|学生)/g,
        type: "KNOWS",
        confidence: 0.85,
        sourceType: "PERSON",
        extractSource: () => "我",
        extractTarget: (match) => match[1].trim(),
        extractProperties: (match) => ({
          relationship: match[2]  // 朋友、同事等
        })
      },

      // ========== LIKES（喜欢） ==========
      {
        pattern: /(.+?)(?:喜欢|热爱|爱好|偏好)(.+?)(?:[，。,.]|$)/g,
        type: "LIKES",
        confidence: 0.9,
        extractSource: (match) => match[1].trim(),
        extractTarget: (match) => match[2].trim()
      },

      // ========== DISLIKES（不喜欢） ==========
      {
        pattern: /(.+?)(?:不喜欢|讨厌|厌恶)(.+?)(?:[，。,.]|$)/g,
        type: "DISLIKES",
        confidence: 0.9,
        extractSource: (match) => match[1].trim(),
        extractTarget: (match) => match[2].trim()
      },

      // ========== HAS_SKILL（拥有技能） ==========
      {
        pattern: /(.+?)(?:擅长|精通|掌握|会)(.+?)(?:编程|开发|设计|语言|技术)/g,
        type: "HAS_SKILL",
        confidence: 0.9,
        sourceType: "PERSON",
        targetType: "SKILL",
        extractSource: (match) => match[1].trim(),
        extractTarget: (match) => match[2].trim()
      },

      // ========== PARTICIPATED_IN（参与） ==========
      {
        pattern: /(.+?)(?:参加|参与|组织)(.+?)(?:会议|活动|项目|比赛)/g,
        type: "PARTICIPATED_IN",
        confidence: 0.85,
        sourceType: "PERSON",
        targetType: "EVENT",
        extractSource: (match) => match[1].trim(),
        extractTarget: (match) => match[2].trim()
      },

      // ========== RELATED_TO（相关） ==========
      {
        pattern: /(.+?)(?:相关|关联|涉及)(.+)/g,
        type: "RELATED_TO",
        confidence: 0.7,
        extractSource: (match) => match[1].trim(),
        extractTarget: (match) => match[2].trim()
      },

      // ========== OWNS（拥有） ==========
      {
        pattern: /(.+?)(?:拥有|有|持有)(.+?)(?:[，。,.]|$)/g,
        type: "OWNS",
        confidence: 0.75,
        extractSource: (match) => match[1].trim(),
        extractTarget: (match) => match[2].trim()
      },

      // ========== HAPPENED_AT（发生于） ==========
      {
        pattern: /(.+?)(?:发生在|在)(.+?)(?:时候|时间)/g,
        type: "HAPPENED_AT",
        confidence: 0.8,
        targetType: "TIME",
        extractSource: (match) => match[1].trim(),
        extractTarget: (match) => match[2].trim()
      }
    ];
  }

  /**
   * 提取关系（主入口）
   */
  async extractRelations(
    text: string,
    entities: GraphEntity[],
    userId: string,
    memoryId: string,
    options: RelationExtractionOptions = {}
  ): Promise<GraphRelation[]> {
    const startTime = Date.now();

    // 规则提取
    const ruleRelations = this.extractByRules(text, entities);

    log("debug", "Rule-based relation extraction completed", {
      text: text.slice(0, 50),
      relationCount: ruleRelations.length
    });

    // LLM增强（可选）
    let llmRelations: RelationExtractionResult[] = [];
    if (options.useLLM) {
      try {
        llmRelations = await this.extractByLLM(text, entities, userId);
        log("debug", "LLM-enhanced relation extraction completed", {
          relationCount: llmRelations.length
        });
      } catch (error) {
        log("warn", "LLM relation extraction failed, using rule-based only", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // 合并去重
    const mergedRelations = this.mergeExtractions(ruleRelations, llmRelations);

    // 过滤低置信度关系
    const threshold = options.confidenceThreshold ?? 0.5;
    const filteredRelations = mergedRelations.filter(r => r.confidence >= threshold);

    // 转换为GraphRelation
    const graphRelations: GraphRelation[] = [];

    for (const relation of filteredRelations) {
      // 查找源实体和目标实体
      const sourceEntity = this.findEntityByName(entities, relation.sourceName);
      const targetEntity = this.findEntityByName(entities, relation.targetName);

      if (!sourceEntity || !targetEntity) {
        log("debug", "Skipping relation due to missing entities", {
          source: relation.sourceName,
          target: relation.targetName,
          type: relation.type
        });
        continue;
      }

      graphRelations.push(this.toGraphRelation(
        relation,
        sourceEntity.id,
        targetEntity.id,
        userId,
        memoryId
      ));
    }

    const duration = Date.now() - startTime;

    log("info", "Relation extraction completed", {
      text: text.slice(0, 50),
      ruleCount: ruleRelations.length,
      llmCount: llmRelations.length,
      mergedCount: mergedRelations.length,
      finalCount: graphRelations.length,
      duration
    });

    return graphRelations;
  }

  /**
   * 规则提取
   */
  private extractByRules(
    text: string,
    entities: GraphEntity[]
  ): RelationExtractionResult[] {
    const results: RelationExtractionResult[] = [];
    const seen = new Set<string>();

    for (const patternDef of this.patterns) {
      // 重置正则的lastIndex
      patternDef.pattern.lastIndex = 0;

      let match: RegExpMatchArray | null;
      while ((match = patternDef.pattern.exec(text)) !== null) {
        const sourceName = patternDef.extractSource(match);
        const targetName = patternDef.extractTarget(match);

        // 去除空白和无效名称
        if (!sourceName || !targetName || sourceName.length < 1 || targetName.length < 1) {
          continue;
        }

        // 去重
        const key = `${sourceName}:${patternDef.type}:${targetName}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        // 验证实体类型（如果指定）
        if (patternDef.sourceType || patternDef.targetType) {
          const sourceEntity = this.findEntityByName(entities, sourceName);
          const targetEntity = this.findEntityByName(entities, targetName);

          if (patternDef.sourceType && sourceEntity && sourceEntity.type !== patternDef.sourceType) {
            continue;
          }
          if (patternDef.targetType && targetEntity && targetEntity.type !== patternDef.targetType) {
            continue;
          }
        }

        results.push({
          sourceName,
          targetName,
          type: patternDef.type,
          confidence: patternDef.confidence,
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
    entities: GraphEntity[],
    userId: string
  ): Promise<RelationExtractionResult[]> {
    // TODO: 集成PI Agent调用LLM进行关系提取
    // 需要构造prompt，要求LLM返回JSON格式的关系列表

    // 暂时返回空数组，未来实现时可以调用PI Agent
    log("debug", "LLM relation extraction not implemented yet", {
      text: text.slice(0, 50),
      entityCount: entities.length,
      userId
    });

    return [];
  }

  /**
   * 合并提取结果
   */
  private mergeExtractions(
    ruleRelations: RelationExtractionResult[],
    llmRelations: RelationExtractionResult[]
  ): RelationExtractionResult[] {
    const merged = new Map<string, RelationExtractionResult>();

    // 添加规则关系
    for (const relation of ruleRelations) {
      const key = `${relation.sourceName}:${relation.type}:${relation.targetName}`;
      merged.set(key, relation);
    }

    // 合并LLM关系（如果置信度更高则替换）
    for (const relation of llmRelations) {
      const key = `${relation.sourceName}:${relation.type}:${relation.targetName}`;
      const existing = merged.get(key);

      if (!existing || relation.confidence > existing.confidence) {
        merged.set(key, relation);
      } else if (existing) {
        // 合并属性
        existing.properties = {
          ...existing.properties,
          ...relation.properties
        };
        // 取平均置信度
        existing.confidence = (existing.confidence + relation.confidence) / 2;
      }
    }

    return Array.from(merged.values());
  }

  /**
   * 转换为GraphRelation
   */
  private toGraphRelation(
    extraction: RelationExtractionResult,
    sourceId: string,
    targetId: string,
    userId: string,
    memoryId: string
  ): GraphRelation {
    const now = Date.now();

    return {
      id: generateRelationId(),
      sourceId,
      targetId,
      type: extraction.type,
      properties: extraction.properties || {},
      confidence: extraction.confidence,
      temporal: {
        timestamp: now
      },
      source: {
        memoryId,
        userId
      }
    };
  }

  /**
   * 按名称查找实体
   */
  private findEntityByName(
    entities: GraphEntity[],
    name: string
  ): GraphEntity | undefined {
    const normalized = name.toLowerCase().trim();

    // 精确匹配
    let found = entities.find(e => e.name.toLowerCase() === normalized);
    if (found) return found;

    // 别名匹配
    found = entities.find(e =>
      e.aliases.some(alias => alias.toLowerCase() === normalized)
    );
    if (found) return found;

    // 包含匹配
    found = entities.find(e => e.name.toLowerCase().includes(normalized));
    if (found) return found;

    // 反向包含匹配
    found = entities.find(e => normalized.includes(e.name.toLowerCase()));
    if (found) return found;

    return undefined;
  }

  /**
   * 添加自定义模式
   */
  addPattern(pattern: RelationPattern): void {
    this.patterns.push(pattern);
    log("debug", "Custom relation pattern added", {
      type: pattern.type,
      confidence: pattern.confidence
    });
  }

  /**
   * 获取所有模式
   */
  getPatterns(): RelationPattern[] {
    return [...this.patterns];
  }
}

// 导出单例实例
export const relationExtractor = new RelationExtractor();
