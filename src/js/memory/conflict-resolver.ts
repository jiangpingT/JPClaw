/**
 * 智能冲突解决系统
 * 自动检测和解决记忆中的信息冲突
 */

import { log, logError } from "../shared/logger.js";
import { JPClawError, ErrorCode } from "../shared/errors.js";
import { metrics } from "../monitoring/metrics.js";
import { vectorMemoryStore, type MemoryVector, type VectorSearchResult } from "./vector-store.js";
import type { FactConflict } from "./conflicts.js";

export interface ConflictResolution {
  conflictId: string;
  type: ConflictType;
  description: string;
  oldValue: string;
  newValue: string;
  confidence: number;
  reasoning: string;
  action: ResolutionAction;
  timestamp: number;
}

export interface IntelligentConflict {
  id: string;
  type: ConflictType;
  entities: ConflictEntity[];
  context: {
    relatedMemories: MemoryVector[];
    temporalEvidence: TemporalEvidence[];
    sourceCredibility: SourceCredibility[];
  };
  severity: "low" | "medium" | "high" | "critical";
  autoResolvable: boolean;
  suggestedResolution?: ConflictResolution;
  metadata: {
    detectedAt: number;
    userId: string;
    category: string;
  };
}

export interface ConflictEntity {
  id: string;
  content: string;
  source: MemoryVector;
  evidence: Evidence[];
  credibilityScore: number;
}

export interface Evidence {
  type: "temporal" | "frequency" | "source_authority" | "context" | "user_preference";
  value: number;
  description: string;
  weight: number;
}

export interface TemporalEvidence {
  timestamp: number;
  content: string;
  confidence: number;
}

export interface SourceCredibility {
  source: string;
  credibilityScore: number;
  evidenceCount: number;
  lastUpdated: number;
}

export type ConflictType = 
  | "factual_contradiction"
  | "temporal_inconsistency" 
  | "preference_change"
  | "duplicate_information"
  | "outdated_information"
  | "contextual_mismatch";

export type ResolutionAction =
  | "merge"
  | "replace"
  | "archive"
  | "flag_for_review"
  | "create_alternative"
  | "update_confidence";

export class IntelligentConflictResolver {
  private static instance: IntelligentConflictResolver;
  private detectedConflicts = new Map<string, IntelligentConflict>();
  private resolutionHistory = new Map<string, ConflictResolution[]>();
  private sourceCredibilityMap = new Map<string, SourceCredibility>();
  private static initializing = false;

  private constructor() {
    this.loadCredibilityData();
  }

  /**
   * 优化：防止竞态条件的单例实现
   */
  static getInstance(): IntelligentConflictResolver {
    if (this.instance) {
      return this.instance;
    }

    if (this.initializing) {
      throw new Error("IntelligentConflictResolver is already being initialized. Please wait for initialization to complete.");
    }

    try {
      this.initializing = true;
      this.instance = new IntelligentConflictResolver();
      return this.instance;
    } finally {
      this.initializing = false;
    }
  }

  /**
   * 检测记忆中的智能冲突
   */
  async detectConflicts(
    newMemory: MemoryVector,
    existingMemories: MemoryVector[]
  ): Promise<IntelligentConflict[]> {
    try {
      const conflicts: IntelligentConflict[] = [];

      // 1. 语义相似性检测
      const semanticConflicts = await this.detectSemanticConflicts(newMemory, existingMemories);
      conflicts.push(...semanticConflicts);

      // 2. 事实冲突检测
      const factualConflicts = await this.detectFactualConflicts(newMemory, existingMemories);
      conflicts.push(...factualConflicts);

      // 3. 时间一致性检测
      const temporalConflicts = await this.detectTemporalConflicts(newMemory, existingMemories);
      conflicts.push(...temporalConflicts);

      // 4. 偏好冲突检测
      const preferenceConflicts = await this.detectPreferenceConflicts(newMemory, existingMemories);
      conflicts.push(...preferenceConflicts);

      // 5. 重复信息检测
      const duplicateConflicts = await this.detectDuplicates(newMemory, existingMemories);
      conflicts.push(...duplicateConflicts);

      // 缓存检测到的冲突
      for (const conflict of conflicts) {
        this.detectedConflicts.set(conflict.id, conflict);
      }

      log("info", "Conflict detection completed", {
        newMemoryId: newMemory.id,
        conflictsFound: conflicts.length,
        types: conflicts.map(c => c.type)
      });

      metrics.increment("memory.conflicts.detected", conflicts.length, {
        userId: newMemory.metadata.userId
      });

      return conflicts;
    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to detect conflicts",
        cause: error instanceof Error ? error : undefined
      }));
      return [];
    }
  }

  /**
   * 自动解决冲突
   */
  async resolveConflict(conflictId: string): Promise<ConflictResolution | null> {
    const conflict = this.detectedConflicts.get(conflictId);
    if (!conflict) {
      log("warn", "Conflict not found for resolution", { conflictId });
      return null;
    }

    try {
      let resolution: ConflictResolution | null = null;

      switch (conflict.type) {
        case "factual_contradiction":
          resolution = await this.resolveFactualConflict(conflict);
          break;
        case "temporal_inconsistency":
          resolution = await this.resolveTemporalConflict(conflict);
          break;
        case "preference_change":
          resolution = await this.resolvePreferenceConflict(conflict);
          break;
        case "duplicate_information":
          resolution = await this.resolveDuplicate(conflict);
          break;
        case "outdated_information":
          resolution = await this.resolveOutdatedInfo(conflict);
          break;
        case "contextual_mismatch":
          resolution = await this.resolveContextualMismatch(conflict);
          break;
      }

      if (resolution) {
        // 执行解决方案
        await this.executeResolution(resolution);

        // 记录解决历史
        if (!this.resolutionHistory.has(conflict.metadata.userId)) {
          this.resolutionHistory.set(conflict.metadata.userId, []);
        }
        this.resolutionHistory.get(conflict.metadata.userId)!.push(resolution);

        // 移除已解决的冲突
        this.detectedConflicts.delete(conflictId);

        log("info", "Conflict resolved", {
          conflictId,
          type: conflict.type,
          action: resolution.action,
          confidence: resolution.confidence
        });

        metrics.increment("memory.conflicts.resolved", 1, {
          type: conflict.type,
          action: resolution.action,
          userId: conflict.metadata.userId
        });
      }

      return resolution;
    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to resolve conflict",
        cause: error instanceof Error ? error : undefined
      }));
      return null;
    }
  }

  /**
   * 批量解决所有可自动解决的冲突
   */
  async resolveAllAutoConflicts(userId: string): Promise<ConflictResolution[]> {
    const userConflicts = Array.from(this.detectedConflicts.values())
      .filter(c => c.metadata.userId === userId && c.autoResolvable);

    const resolutions: ConflictResolution[] = [];

    for (const conflict of userConflicts) {
      const resolution = await this.resolveConflict(conflict.id);
      if (resolution) {
        resolutions.push(resolution);
      }
    }

    log("info", "Batch conflict resolution completed", {
      userId,
      resolvedCount: resolutions.length
    });

    return resolutions;
  }

  /**
   * 获取用户的冲突摘要
   */
  getConflictSummary(userId: string): {
    total: number;
    autoResolvable: number;
    byType: Record<ConflictType, number>;
    bySeverity: Record<string, number>;
  } {
    const userConflicts = Array.from(this.detectedConflicts.values())
      .filter(c => c.metadata.userId === userId);

    const byType: Record<ConflictType, number> = {} as any;
    const bySeverity: Record<string, number> = {};
    let autoResolvable = 0;

    for (const conflict of userConflicts) {
      byType[conflict.type] = (byType[conflict.type] || 0) + 1;
      bySeverity[conflict.severity] = (bySeverity[conflict.severity] || 0) + 1;
      if (conflict.autoResolvable) autoResolvable++;
    }

    return {
      total: userConflicts.length,
      autoResolvable,
      byType,
      bySeverity
    };
  }

  private async detectSemanticConflicts(
    newMemory: MemoryVector,
    existingMemories: MemoryVector[]
  ): Promise<IntelligentConflict[]> {
    const conflicts: IntelligentConflict[] = [];

    // 寻找语义相似但内容不同的记忆
    const similarMemories = await vectorMemoryStore.searchMemories({
      text: newMemory.content,
      filters: { userId: newMemory.metadata.userId },
      limit: 5,
      threshold: 0.7
    });

    for (const similar of similarMemories) {
      if (similar.vector.id === newMemory.id) continue;

      const similarity = similar.similarity;
      const contentSimilarity = this.calculateContentSimilarity(
        newMemory.content,
        similar.vector.content
      );

      // 高语义相似度但内容有差异
      if (similarity > 0.8 && contentSimilarity < 0.6) {
        const conflict = await this.createConflict({
          type: "factual_contradiction",
          entities: [
            this.createConflictEntity(newMemory),
            this.createConflictEntity(similar.vector)
          ],
          severity: this.calculateSeverity(similarity, contentSimilarity),
          userId: newMemory.metadata.userId,
          category: newMemory.metadata.category || "general"
        });

        conflicts.push(conflict);
      }
    }

    return conflicts;
  }

  private async detectFactualConflicts(
    newMemory: MemoryVector,
    existingMemories: MemoryVector[]
  ): Promise<IntelligentConflict[]> {
    const conflicts: IntelligentConflict[] = [];

    // 提取结构化事实
    const newFacts = this.extractFacts(newMemory.content);
    
    for (const existingMemory of existingMemories) {
      const existingFacts = this.extractFacts(existingMemory.content);
      
      for (const newFact of newFacts) {
        for (const existingFact of existingFacts) {
          if (this.areFactsConflicting(newFact, existingFact)) {
            const conflict = await this.createConflict({
              type: "factual_contradiction",
              entities: [
                this.createConflictEntity(newMemory),
                this.createConflictEntity(existingMemory)
              ],
              severity: "high",
              userId: newMemory.metadata.userId,
              category: "factual"
            });

            conflicts.push(conflict);
          }
        }
      }
    }

    return conflicts;
  }

  private async detectTemporalConflicts(
    newMemory: MemoryVector,
    existingMemories: MemoryVector[]
  ): Promise<IntelligentConflict[]> {
    const conflicts: IntelligentConflict[] = [];

    // 检测时间相关的冲突
    const temporalPatterns = [
      /(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/g, // 日期
      /(今天|昨天|明天|上周|下周|去年|明年)/g, // 相对时间
      /(之前|之后|当时|现在|将来)/g // 时间状语
    ];

    for (const existingMemory of existingMemories) {
      if (this.hasTemporalConflict(newMemory, existingMemory, temporalPatterns)) {
        const conflict = await this.createConflict({
          type: "temporal_inconsistency",
          entities: [
            this.createConflictEntity(newMemory),
            this.createConflictEntity(existingMemory)
          ],
          severity: "medium",
          userId: newMemory.metadata.userId,
          category: "temporal"
        });

        conflicts.push(conflict);
      }
    }

    return conflicts;
  }

  private async detectPreferenceConflicts(
    newMemory: MemoryVector,
    existingMemories: MemoryVector[]
  ): Promise<IntelligentConflict[]> {
    const conflicts: IntelligentConflict[] = [];

    // 检测偏好相关的冲突
    const preferenceKeywords = [
      "喜欢", "不喜欢", "偏好", "讨厌", "爱好",
      "倾向", "选择", "认为", "觉得", "相信"
    ];

    for (const existingMemory of existingMemories) {
      if (this.hasPreferenceConflict(newMemory, existingMemory, preferenceKeywords)) {
        const conflict = await this.createConflict({
          type: "preference_change",
          entities: [
            this.createConflictEntity(newMemory),
            this.createConflictEntity(existingMemory)
          ],
          severity: "low",
          userId: newMemory.metadata.userId,
          category: "preference"
        });

        conflicts.push(conflict);
      }
    }

    return conflicts;
  }

  private async detectDuplicates(
    newMemory: MemoryVector,
    existingMemories: MemoryVector[]
  ): Promise<IntelligentConflict[]> {
    const conflicts: IntelligentConflict[] = [];

    for (const existingMemory of existingMemories) {
      const similarity = this.calculateContentSimilarity(
        newMemory.content,
        existingMemory.content
      );

      // 高度相似的内容视为重复
      if (similarity > 0.9) {
        const conflict = await this.createConflict({
          type: "duplicate_information",
          entities: [
            this.createConflictEntity(newMemory),
            this.createConflictEntity(existingMemory)
          ],
          severity: "low",
          userId: newMemory.metadata.userId,
          category: "duplicate"
        });

        conflicts.push(conflict);
      }
    }

    return conflicts;
  }

  private async createConflict(options: {
    type: ConflictType;
    entities: ConflictEntity[];
    severity: IntelligentConflict["severity"];
    userId: string;
    category: string;
  }): Promise<IntelligentConflict> {
    const conflictId = this.generateConflictId();
    
    // 收集相关记忆作为上下文
    const relatedMemories = await vectorMemoryStore.searchMemories({
      text: options.entities.map(e => e.content).join(" "),
      filters: { userId: options.userId },
      limit: 5
    });

    // 构建时间证据
    const temporalEvidence = this.buildTemporalEvidence(options.entities);

    // 评估可自动解决性
    const autoResolvable = this.canAutoResolve(options.type, options.severity, options.entities);

    const conflict: IntelligentConflict = {
      id: conflictId,
      type: options.type,
      entities: options.entities,
      context: {
        relatedMemories: relatedMemories.map(r => r.vector),
        temporalEvidence,
        sourceCredibility: this.getSourceCredibility(options.entities)
      },
      severity: options.severity,
      autoResolvable,
      suggestedResolution: autoResolvable ? await this.generateSuggestedResolution(options) : undefined,
      metadata: {
        detectedAt: Date.now(),
        userId: options.userId,
        category: options.category
      }
    };

    return conflict;
  }

  private createConflictEntity(memory: MemoryVector): ConflictEntity {
    const evidence = this.gatherEvidence(memory);
    const credibilityScore = this.calculateCredibilityScore(memory, evidence);

    return {
      id: memory.id,
      content: memory.content,
      source: memory,
      evidence,
      credibilityScore
    };
  }

  private gatherEvidence(memory: MemoryVector): Evidence[] {
    const evidence: Evidence[] = [];

    // 时间证据
    const age = Date.now() - memory.metadata.timestamp;
    const freshnessScore = Math.exp(-age / (7 * 24 * 60 * 60 * 1000)); // 7天半衰期
    evidence.push({
      type: "temporal",
      value: freshnessScore,
      description: "Information freshness",
      weight: 0.3
    });

    // 访问频率证据
    const accessScore = Math.min(1, memory.accessCount / 10);
    evidence.push({
      type: "frequency",
      value: accessScore,
      description: "Access frequency",
      weight: 0.2
    });

    // 重要性证据
    evidence.push({
      type: "source_authority",
      value: memory.metadata.importance,
      description: "Assigned importance",
      weight: 0.3
    });

    // 上下文相关性
    const contextScore = this.calculateContextualRelevance(memory);
    evidence.push({
      type: "context",
      value: contextScore,
      description: "Contextual relevance",
      weight: 0.2
    });

    return evidence;
  }

  private calculateCredibilityScore(memory: MemoryVector, evidence: Evidence[]): number {
    let totalScore = 0;
    let totalWeight = 0;

    for (const ev of evidence) {
      totalScore += ev.value * ev.weight;
      totalWeight += ev.weight;
    }

    return totalWeight > 0 ? totalScore / totalWeight : 0.5;
  }

  private calculateContextualRelevance(memory: MemoryVector): number {
    // 简化的上下文相关性计算
    // 实际实现应该考虑更多上下文因素
    const hasContext = memory.metadata.category !== undefined;
    const hasTag = memory.metadata.tags && memory.metadata.tags.length > 0;
    
    return (hasContext ? 0.5 : 0) + (hasTag ? 0.5 : 0);
  }

  private async executeResolution(resolution: ConflictResolution): Promise<void> {
    switch (resolution.action) {
      case "merge":
        // 合并信息
        break;
      case "replace":
        // 替换旧信息
        break;
      case "archive":
        // 归档旧信息
        break;
      case "update_confidence":
        // 更新置信度
        break;
      // 其他动作的实现
    }
  }

  private generateConflictId(): string {
    return `conflict_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  private calculateContentSimilarity(content1: string, content2: string): number {
    // 简化的内容相似度计算
    const words1 = new Set(content1.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
    const words2 = new Set(content2.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  private extractFacts(content: string): Array<{ key: string; value: string }> {
    // 简化的事实提取
    const facts: Array<{ key: string; value: string }> = [];
    const patterns = [
      /(.+?)是(.+?)$/gm,
      /(.+?)：(.+?)$/gm,
      /(.+?)为(.+?)$/gm
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        facts.push({
          key: match[1].trim(),
          value: match[2].trim()
        });
      }
    }

    return facts;
  }

  private areFactsConflicting(fact1: { key: string; value: string }, fact2: { key: string; value: string }): boolean {
    // 检查是否是同一个实体的不同值
    const keySimilarity = this.calculateContentSimilarity(fact1.key, fact2.key);
    const valueSimilarity = this.calculateContentSimilarity(fact1.value, fact2.value);
    
    return keySimilarity > 0.8 && valueSimilarity < 0.3;
  }

  private hasTemporalConflict(
    memory1: MemoryVector,
    memory2: MemoryVector,
    patterns: RegExp[]
  ): boolean {
    // 简化的时间冲突检测
    // 实际实现应该更复杂
    for (const pattern of patterns) {
      const matches1 = memory1.content.match(pattern);
      const matches2 = memory2.content.match(pattern);
      
      if (matches1 && matches2) {
        // 如果有时间表达式但指向不同时间，可能存在冲突
        return matches1[0] !== matches2[0];
      }
    }
    
    return false;
  }

  private hasPreferenceConflict(
    memory1: MemoryVector,
    memory2: MemoryVector,
    keywords: string[]
  ): boolean {
    const content1 = memory1.content.toLowerCase();
    const content2 = memory2.content.toLowerCase();
    
    // 检查是否都包含偏好关键词
    const hasKeyword1 = keywords.some(kw => content1.includes(kw));
    const hasKeyword2 = keywords.some(kw => content2.includes(kw));
    
    if (!hasKeyword1 || !hasKeyword2) return false;
    
    // 检查是否表达了相反的偏好
    const positive1 = content1.includes("喜欢") || content1.includes("爱好");
    const negative1 = content1.includes("不喜欢") || content1.includes("讨厌");
    const positive2 = content2.includes("喜欢") || content2.includes("爱好");
    const negative2 = content2.includes("不喜欢") || content2.includes("讨厌");
    
    return (positive1 && negative2) || (negative1 && positive2);
  }

  private calculateSeverity(
    similarity: number,
    contentSimilarity: number
  ): IntelligentConflict["severity"] {
    const conflictScore = similarity - contentSimilarity;
    
    if (conflictScore > 0.5) return "critical";
    if (conflictScore > 0.3) return "high";
    if (conflictScore > 0.2) return "medium";
    return "low";
  }

  private buildTemporalEvidence(entities: ConflictEntity[]): TemporalEvidence[] {
    return entities.map(entity => ({
      timestamp: entity.source.metadata.timestamp,
      content: entity.content,
      confidence: entity.credibilityScore
    })).sort((a, b) => b.timestamp - a.timestamp);
  }

  private getSourceCredibility(entities: ConflictEntity[]): SourceCredibility[] {
    const credibilityMap = new Map<string, SourceCredibility>();
    
    for (const entity of entities) {
      const sourceKey = entity.source.metadata.type;
      if (!credibilityMap.has(sourceKey)) {
        credibilityMap.set(sourceKey, {
          source: sourceKey,
          credibilityScore: entity.credibilityScore,
          evidenceCount: 1,
          lastUpdated: entity.source.metadata.timestamp
        });
      } else {
        const existing = credibilityMap.get(sourceKey)!;
        existing.credibilityScore = (existing.credibilityScore + entity.credibilityScore) / 2;
        existing.evidenceCount++;
        existing.lastUpdated = Math.max(existing.lastUpdated, entity.source.metadata.timestamp);
      }
    }
    
    return Array.from(credibilityMap.values());
  }

  private canAutoResolve(
    type: ConflictType,
    severity: IntelligentConflict["severity"],
    entities: ConflictEntity[]
  ): boolean {
    // 低严重性冲突通常可以自动解决
    if (severity === "low") return true;
    
    // 重复信息总是可以自动解决
    if (type === "duplicate_information") return true;
    
    // 如果有明显的置信度差异，可以自动解决
    const credibilityDiff = Math.abs(entities[0].credibilityScore - entities[1].credibilityScore);
    if (credibilityDiff > 0.3) return true;
    
    // 其他情况需要人工干预
    return false;
  }

  private async generateSuggestedResolution(options: {
    type: ConflictType;
    entities: ConflictEntity[];
    severity: IntelligentConflict["severity"];
  }): Promise<ConflictResolution> {
    // 简化的建议生成
    // 实际应该基于更复杂的逻辑
    
    const higherCredibility = options.entities.reduce((prev, current) => 
      prev.credibilityScore > current.credibilityScore ? prev : current
    );
    
    const lowerCredibility = options.entities.find(e => e !== higherCredibility)!;
    
    return {
      conflictId: this.generateConflictId(),
      type: options.type,
      description: `Resolve ${options.type} by favoring higher credibility source`,
      oldValue: lowerCredibility.content,
      newValue: higherCredibility.content,
      confidence: Math.abs(higherCredibility.credibilityScore - lowerCredibility.credibilityScore),
      reasoning: `Higher credibility source (${higherCredibility.credibilityScore.toFixed(2)} vs ${lowerCredibility.credibilityScore.toFixed(2)})`,
      action: "replace",
      timestamp: Date.now()
    };
  }

  private async resolveFactualConflict(conflict: IntelligentConflict): Promise<ConflictResolution | null> {
    // 基于证据权重和时间新鲜度解决事实冲突
    const entities = conflict.entities.sort((a, b) => b.credibilityScore - a.credibilityScore);
    const winner = entities[0];
    const loser = entities[1];
    
    return {
      conflictId: conflict.id,
      type: conflict.type,
      description: "Resolved factual conflict based on evidence weight",
      oldValue: loser.content,
      newValue: winner.content,
      confidence: winner.credibilityScore,
      reasoning: `Evidence score: ${winner.credibilityScore.toFixed(2)} vs ${loser.credibilityScore.toFixed(2)}`,
      action: "replace",
      timestamp: Date.now()
    };
  }

  private async resolveTemporalConflict(conflict: IntelligentConflict): Promise<ConflictResolution | null> {
    // 时间冲突通常保留最新的信息
    const sortedByTime = conflict.entities.sort((a, b) => 
      b.source.metadata.timestamp - a.source.metadata.timestamp
    );
    
    return {
      conflictId: conflict.id,
      type: conflict.type,
      description: "Resolved temporal conflict by keeping latest information",
      oldValue: sortedByTime[1].content,
      newValue: sortedByTime[0].content,
      confidence: 0.8,
      reasoning: "More recent information takes precedence",
      action: "replace",
      timestamp: Date.now()
    };
  }

  private async resolvePreferenceConflict(conflict: IntelligentConflict): Promise<ConflictResolution | null> {
    // 偏好冲突保留最新的偏好
    const latest = conflict.entities.reduce((prev, current) => 
      prev.source.metadata.timestamp > current.source.metadata.timestamp ? prev : current
    );
    const older = conflict.entities.find(e => e !== latest)!;
    
    return {
      conflictId: conflict.id,
      type: conflict.type,
      description: "Updated preference based on latest information",
      oldValue: older.content,
      newValue: latest.content,
      confidence: 0.9,
      reasoning: "User preferences may change over time",
      action: "replace",
      timestamp: Date.now()
    };
  }

  private async resolveDuplicate(conflict: IntelligentConflict): Promise<ConflictResolution | null> {
    // 重复信息合并或删除重复项
    const entities = conflict.entities.sort((a, b) => b.credibilityScore - a.credibilityScore);
    const primary = entities[0];
    const duplicate = entities[1];
    
    return {
      conflictId: conflict.id,
      type: conflict.type,
      description: "Removed duplicate information",
      oldValue: duplicate.content,
      newValue: primary.content,
      confidence: 0.95,
      reasoning: "Identical or near-identical content detected",
      action: "archive",
      timestamp: Date.now()
    };
  }

  private async resolveOutdatedInfo(conflict: IntelligentConflict): Promise<ConflictResolution | null> {
    // 过期信息更新
    const latest = conflict.entities.reduce((prev, current) => 
      prev.source.metadata.timestamp > current.source.metadata.timestamp ? prev : current
    );
    const outdated = conflict.entities.find(e => e !== latest)!;
    
    return {
      conflictId: conflict.id,
      type: conflict.type,
      description: "Updated outdated information",
      oldValue: outdated.content,
      newValue: latest.content,
      confidence: 0.85,
      reasoning: "Information has been superseded",
      action: "replace",
      timestamp: Date.now()
    };
  }

  private async resolveContextualMismatch(conflict: IntelligentConflict): Promise<ConflictResolution | null> {
    // 上下文不匹配需要更详细的分析
    return {
      conflictId: conflict.id,
      type: conflict.type,
      description: "Flagged contextual mismatch for review",
      oldValue: conflict.entities[0].content,
      newValue: conflict.entities[1].content,
      confidence: 0.5,
      reasoning: "Context analysis required",
      action: "flag_for_review",
      timestamp: Date.now()
    };
  }

  private loadCredibilityData(): void {
    // 加载源可信度数据
    // 实际实现应该从持久化存储加载
  }
}

// 导出全局实例
export const conflictResolver = IntelligentConflictResolver.getInstance();