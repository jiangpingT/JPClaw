/**
 * 技能市场系统
 * 提供技能发现、安装、分享和评级功能
 */

import fs from "node:fs";
import path from "node:path";
import { log, logError } from "../shared/logger.js";
import { JPClawError, ErrorCode } from "../shared/errors.js";
import { metrics } from "../monitoring/metrics.js";
import { skillVersionManager } from "./versioning.js";
import { skillDependencyManager } from "./dependencies.js";

export interface SkillMetadata {
  name: string;
  version: string;
  description: string;
  author: string;
  category: string;
  tags: string[];
  license: string;
  homepage?: string;
  repository?: string;
  documentation?: string;
  downloads: number;
  rating: number;
  ratingCount: number;
  createdAt: string;
  updatedAt: string;
  featured: boolean;
  verified: boolean;
}

export interface SkillPackage {
  metadata: SkillMetadata;
  manifest: any;
  files: Record<string, string>;
  checksum: string;
  size: number;
}

export interface MarketplaceEntry {
  id: string;
  metadata: SkillMetadata;
  versions: string[];
  latestVersion: string;
  compatibility: string[];
  requirements: string[];
  screenshots?: string[];
  readme?: string;
}

export interface SearchFilters {
  category?: string;
  tags?: string[];
  author?: string;
  minRating?: number;
  verified?: boolean;
  featured?: boolean;
  sortBy?: "name" | "downloads" | "rating" | "updated" | "created";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface InstallResult {
  success: boolean;
  skillName: string;
  version: string;
  installedFiles: string[];
  dependencies: string[];
  errors: string[];
}

export class SkillMarketplace {
  private static instance: SkillMarketplace;
  private marketplaceDirectory: string;
  private indexFile: string;
  private cache = new Map<string, MarketplaceEntry>();
  private lastIndexUpdate = 0;

  private constructor() {
    this.marketplaceDirectory = path.resolve(process.cwd(), "sessions", "marketplace");
    this.indexFile = path.join(this.marketplaceDirectory, "index.json");
    
    fs.mkdirSync(this.marketplaceDirectory, { recursive: true });
    this.loadIndex();
  }

  static getInstance(): SkillMarketplace {
    if (!SkillMarketplace.instance) {
      SkillMarketplace.instance = new SkillMarketplace();
    }
    return SkillMarketplace.instance;
  }

  /**
   * 搜索技能
   */
  async searchSkills(query: string, filters: SearchFilters = {}): Promise<{
    results: MarketplaceEntry[];
    total: number;
    page: number;
    hasMore: boolean;
  }> {
    await this.refreshIndex();
    
    const limit = filters.limit || 20;
    const offset = filters.offset || 0;
    const page = Math.floor(offset / limit) + 1;

    let results = Array.from(this.cache.values());

    // 文本搜索
    if (query.trim()) {
      const lowerQuery = query.toLowerCase();
      results = results.filter(entry => {
        return (
          entry.metadata.name.toLowerCase().includes(lowerQuery) ||
          entry.metadata.description.toLowerCase().includes(lowerQuery) ||
          entry.metadata.tags.some(tag => tag.toLowerCase().includes(lowerQuery)) ||
          entry.metadata.author.toLowerCase().includes(lowerQuery)
        );
      });
    }

    // 应用过滤器
    results = this.applyFilters(results, filters);

    // 排序
    results = this.sortResults(results, filters.sortBy || "downloads", filters.sortOrder || "desc");

    // 分页
    const total = results.length;
    const paginatedResults = results.slice(offset, offset + limit);

    metrics.increment("skills.marketplace.search", 1, {
      query: query.slice(0, 50),
      results: total.toString()
    });

    return {
      results: paginatedResults,
      total,
      page,
      hasMore: offset + limit < total
    };
  }

  /**
   * 获取技能详情
   */
  async getSkillDetails(skillName: string, version?: string): Promise<MarketplaceEntry | null> {
    await this.refreshIndex();
    
    const entry = this.cache.get(skillName);
    if (!entry) return null;

    // 如果指定了版本，验证版本是否存在
    if (version && !entry.versions.includes(version)) {
      return null;
    }

    metrics.increment("skills.marketplace.details", 1, {
      skill: skillName,
      version: version || "latest"
    });

    return entry;
  }

  /**
   * 安装技能
   */
  async installSkill(skillName: string, version?: string): Promise<InstallResult> {
    const result: InstallResult = {
      success: false,
      skillName,
      version: version || "latest",
      installedFiles: [],
      dependencies: [],
      errors: []
    };

    try {
      const entry = await this.getSkillDetails(skillName, version);
      if (!entry) {
        result.errors.push(`Skill '${skillName}' not found in marketplace`);
        return result;
      }

      const targetVersion = version || entry.latestVersion;
      result.version = targetVersion;

      // 检查是否已安装
      const existingVersions = await skillVersionManager.getSkillVersions(skillName);
      if (existingVersions.currentVersion === targetVersion) {
        result.errors.push(`Skill '${skillName}@${targetVersion}' is already installed`);
        return result;
      }

      // 下载技能包
      const skillPackage = await this.downloadSkillPackage(skillName, targetVersion);
      if (!skillPackage) {
        result.errors.push(`Failed to download skill package for '${skillName}@${targetVersion}'`);
        return result;
      }

      // 验证依赖
      const dependencyValidation = await skillDependencyManager.validateSkillDependencies(skillName);
      if (!dependencyValidation.valid && dependencyValidation.missing.some(d => d.required)) {
        result.errors.push("Missing required dependencies:");
        result.errors.push(...dependencyValidation.issues);
        return result;
      }

      // 安装技能文件
      const installResult = await this.installSkillFiles(skillName, skillPackage);
      result.installedFiles = installResult.files;

      // 创建版本记录
      await skillVersionManager.createVersion(
        skillName,
        targetVersion,
        `Installed from marketplace`,
        entry.metadata.author
      );

      // 记录下载统计
      await this.incrementDownloadCount(skillName);

      result.success = true;
      result.dependencies = skillPackage.manifest.dependencies?.map((d: any) => d.name) || [];

      log("info", "Skill installed from marketplace", {
        skill: skillName,
        version: targetVersion,
        author: entry.metadata.author
      });

      metrics.increment("skills.marketplace.install", 1, {
        skill: skillName,
        version: targetVersion
      });

      return result;

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.SKILL_EXECUTION_FAILED,
        message: `Failed to install skill '${skillName}'`,
        cause: error instanceof Error ? error : undefined
      }));

      result.errors.push(error instanceof Error ? error.message : String(error));
      return result;
    }
  }

  /**
   * 发布技能到市场
   */
  async publishSkill(
    skillPath: string,
    metadata: Partial<SkillMetadata>,
    publishKey?: string
  ): Promise<{
    success: boolean;
    skillId?: string;
    version?: string;
    errors: string[];
  }> {
    const result: {
      success: boolean;
      skillId?: string;
      version?: string;
      errors: string[];
    } = {
      success: false,
      errors: [] as string[]
    };

    try {
      // 验证技能目录
      if (!fs.existsSync(skillPath)) {
        result.errors.push(`Skill directory not found: ${skillPath}`);
        return result;
      }

      // 加载技能清单
      const manifest = await this.loadSkillManifest(skillPath);
      if (!manifest) {
        result.errors.push("Skill manifest (skill.json or SKILL.md) not found");
        return result;
      }

      // 验证元数据
      const validationErrors = this.validateMetadata(metadata, manifest);
      if (validationErrors.length > 0) {
        result.errors.push(...validationErrors);
        return result;
      }

      // 创建技能包
      const skillPackage = await this.createSkillPackage(skillPath, metadata, manifest);
      
      // 保存到本地市场目录
      await this.saveSkillToMarketplace(skillPackage);

      // 更新索引
      await this.updateMarketplaceIndex(skillPackage.metadata);

      result.success = true;
      result.skillId = skillPackage.metadata.name;
      result.version = skillPackage.metadata.version;

      log("info", "Skill published to marketplace", {
        skill: skillPackage.metadata.name,
        version: skillPackage.metadata.version,
        author: skillPackage.metadata.author
      });

      metrics.increment("skills.marketplace.publish", 1, {
        skill: skillPackage.metadata.name,
        category: skillPackage.metadata.category
      });

      return result;

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.SKILL_EXECUTION_FAILED,
        message: "Failed to publish skill",
        cause: error instanceof Error ? error : undefined
      }));

      result.errors.push(error instanceof Error ? error.message : String(error));
      return result;
    }
  }

  /**
   * 获取热门技能
   */
  async getFeaturedSkills(limit: number = 10): Promise<MarketplaceEntry[]> {
    await this.refreshIndex();
    
    return Array.from(this.cache.values())
      .filter(entry => entry.metadata.featured || entry.metadata.verified)
      .sort((a, b) => {
        // 优先显示 featured，然后按下载量排序
        if (a.metadata.featured && !b.metadata.featured) return -1;
        if (!a.metadata.featured && b.metadata.featured) return 1;
        return b.metadata.downloads - a.metadata.downloads;
      })
      .slice(0, limit);
  }

  /**
   * 获取分类列表
   */
  async getCategories(): Promise<Array<{ name: string; count: number; description?: string }>> {
    await this.refreshIndex();
    
    const categoryMap = new Map<string, number>();
    
    for (const entry of this.cache.values()) {
      const category = entry.metadata.category || "uncategorized";
      categoryMap.set(category, (categoryMap.get(category) || 0) + 1);
    }

    const categories = Array.from(categoryMap.entries())
      .map(([name, count]) => ({ 
        name, 
        count,
        description: this.getCategoryDescription(name)
      }))
      .sort((a, b) => b.count - a.count);

    return categories;
  }

  /**
   * 评价技能
   */
  async rateSkill(skillName: string, rating: number, userId?: string): Promise<{
    success: boolean;
    newRating: number;
    ratingCount: number;
  }> {
    if (rating < 1 || rating > 5) {
      throw new JPClawError({
        code: ErrorCode.INPUT_VALIDATION_FAILED,
        message: "Rating must be between 1 and 5"
      });
    }

    const entry = this.cache.get(skillName);
    if (!entry) {
      throw new JPClawError({
        code: ErrorCode.SKILL_NOT_FOUND,
        message: `Skill '${skillName}' not found`
      });
    }

    // 简化的评分系统（实际应该防止重复评分）
    const currentTotal = entry.metadata.rating * entry.metadata.ratingCount;
    const newRatingCount = entry.metadata.ratingCount + 1;
    const newRating = (currentTotal + rating) / newRatingCount;

    entry.metadata.rating = Math.round(newRating * 10) / 10; // 保留一位小数
    entry.metadata.ratingCount = newRatingCount;
    entry.metadata.updatedAt = new Date().toISOString();

    await this.saveMarketplaceIndex();

    log("info", "Skill rated", {
      skill: skillName,
      rating,
      newAvgRating: entry.metadata.rating,
      totalRatings: newRatingCount
    });

    metrics.increment("skills.marketplace.rating", 1, {
      skill: skillName,
      rating: rating.toString()
    });

    return {
      success: true,
      newRating: entry.metadata.rating,
      ratingCount: newRatingCount
    };
  }

  private async refreshIndex(): Promise<void> {
    const now = Date.now();
    
    // 如果距离上次更新超过5分钟，重新加载索引
    if (now - this.lastIndexUpdate > 5 * 60 * 1000) {
      this.loadIndex();
    }
  }

  private loadIndex(): void {
    try {
      if (fs.existsSync(this.indexFile)) {
        const content = fs.readFileSync(this.indexFile, 'utf-8');
        const data = JSON.parse(content) as Record<string, MarketplaceEntry>;
        
        this.cache.clear();
        for (const [key, entry] of Object.entries(data)) {
          this.cache.set(key, entry);
        }
      }
      
      this.lastIndexUpdate = Date.now();
      
      log("info", "Marketplace index loaded", {
        skillCount: this.cache.size
      });
    } catch (error) {
      log("warn", "Failed to load marketplace index", {
        error: String(error)
      });
    }
  }

  private async saveMarketplaceIndex(): Promise<void> {
    try {
      const data: Record<string, MarketplaceEntry> = {};
      for (const [key, entry] of this.cache) {
        data[key] = entry;
      }
      
      fs.writeFileSync(this.indexFile, JSON.stringify(data, null, 2));
      this.lastIndexUpdate = Date.now();
    } catch (error) {
      log("error", "Failed to save marketplace index", {
        error: String(error)
      });
    }
  }

  private applyFilters(results: MarketplaceEntry[], filters: SearchFilters): MarketplaceEntry[] {
    return results.filter(entry => {
      if (filters.category && entry.metadata.category !== filters.category) {
        return false;
      }
      
      if (filters.tags && !filters.tags.some(tag => entry.metadata.tags.includes(tag))) {
        return false;
      }
      
      if (filters.author && entry.metadata.author !== filters.author) {
        return false;
      }
      
      if (filters.minRating && entry.metadata.rating < filters.minRating) {
        return false;
      }
      
      if (filters.verified !== undefined && entry.metadata.verified !== filters.verified) {
        return false;
      }
      
      if (filters.featured !== undefined && entry.metadata.featured !== filters.featured) {
        return false;
      }
      
      return true;
    });
  }

  private sortResults(
    results: MarketplaceEntry[], 
    sortBy: string, 
    sortOrder: "asc" | "desc"
  ): MarketplaceEntry[] {
    return results.sort((a, b) => {
      let comparison = 0;
      
      switch (sortBy) {
        case "name":
          comparison = a.metadata.name.localeCompare(b.metadata.name);
          break;
        case "downloads":
          comparison = a.metadata.downloads - b.metadata.downloads;
          break;
        case "rating":
          comparison = a.metadata.rating - b.metadata.rating;
          break;
        case "updated":
          comparison = new Date(a.metadata.updatedAt).getTime() - new Date(b.metadata.updatedAt).getTime();
          break;
        case "created":
          comparison = new Date(a.metadata.createdAt).getTime() - new Date(b.metadata.createdAt).getTime();
          break;
        default:
          comparison = 0;
      }
      
      return sortOrder === "desc" ? -comparison : comparison;
    });
  }

  private async downloadSkillPackage(skillName: string, version: string): Promise<SkillPackage | null> {
    // 简化实现：从本地市场目录加载
    const packagePath = path.join(this.marketplaceDirectory, "packages", skillName, `${version}.json`);
    
    if (!fs.existsSync(packagePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(packagePath, 'utf-8');
      return JSON.parse(content) as SkillPackage;
    } catch (error) {
      log("error", "Failed to load skill package", {
        skill: skillName,
        version,
        error: String(error)
      });
      return null;
    }
  }

  private async installSkillFiles(skillName: string, skillPackage: SkillPackage): Promise<{
    files: string[];
  }> {
    const skillsDir = path.resolve(process.cwd(), "skills");
    const installPath = path.join(skillsDir, skillName);
    
    // 清理现有安装
    if (fs.existsSync(installPath)) {
      fs.rmSync(installPath, { recursive: true, force: true });
    }
    
    fs.mkdirSync(installPath, { recursive: true });
    
    const installedFiles: string[] = [];
    
    for (const [relativePath, content] of Object.entries(skillPackage.files)) {
      const targetPath = path.join(installPath, relativePath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, Buffer.from(content, 'base64'));
      installedFiles.push(relativePath);
    }
    
    return { files: installedFiles };
  }

  private async incrementDownloadCount(skillName: string): Promise<void> {
    const entry = this.cache.get(skillName);
    if (entry) {
      entry.metadata.downloads++;
      entry.metadata.updatedAt = new Date().toISOString();
      await this.saveMarketplaceIndex();
    }
  }

  private async loadSkillManifest(skillPath: string): Promise<any | null> {
    const manifestPath = path.join(skillPath, "skill.json");
    
    if (fs.existsSync(manifestPath)) {
      try {
        const content = fs.readFileSync(manifestPath, 'utf-8');
        return JSON.parse(content);
      } catch (error) {
        return null;
      }
    }
    
    // 尝试从 SKILL.md 提取信息
    const skillMdPath = path.join(skillPath, "SKILL.md");
    if (fs.existsSync(skillMdPath)) {
      // 简化实现
      return {
        name: path.basename(skillPath),
        version: "1.0.0",
        entry: "SKILL.md"
      };
    }
    
    return null;
  }

  private validateMetadata(metadata: Partial<SkillMetadata>, manifest: any): string[] {
    const errors: string[] = [];
    
    if (!metadata.name && !manifest.name) {
      errors.push("Skill name is required");
    }
    
    if (!metadata.description && !manifest.description) {
      errors.push("Skill description is required");
    }
    
    if (!metadata.author) {
      errors.push("Author information is required");
    }
    
    if (!metadata.category) {
      errors.push("Category is required");
    }
    
    if (!metadata.version && !manifest.version) {
      errors.push("Version is required");
    }
    
    return errors;
  }

  private async createSkillPackage(
    skillPath: string,
    metadata: Partial<SkillMetadata>,
    manifest: any
  ): Promise<SkillPackage> {
    // 收集所有文件
    const files: Record<string, string> = {};
    const collectFiles = (dirPath: string, basePath: string = "") => {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.join(basePath, entry.name);
        
        if (entry.isFile()) {
          const content = fs.readFileSync(fullPath);
          files[relativePath] = content.toString('base64');
        } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
          collectFiles(fullPath, relativePath);
        }
      }
    };
    
    collectFiles(skillPath);
    
    // 计算校验和和大小
    const filesContent = JSON.stringify(files);
    const checksum = require('crypto').createHash('sha256').update(filesContent).digest('hex');
    const size = Buffer.byteLength(filesContent);
    
    // 合并元数据
    const finalMetadata: SkillMetadata = {
      name: metadata.name || manifest.name,
      version: metadata.version || manifest.version,
      description: metadata.description || manifest.description,
      author: metadata.author || manifest.author || "Unknown",
      category: metadata.category || "general",
      tags: metadata.tags || manifest.tags || [],
      license: metadata.license || manifest.license || "MIT",
      homepage: metadata.homepage,
      repository: metadata.repository,
      documentation: metadata.documentation,
      downloads: 0,
      rating: 0,
      ratingCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      featured: false,
      verified: false
    };
    
    return {
      metadata: finalMetadata,
      manifest,
      files,
      checksum,
      size
    };
  }

  private async saveSkillToMarketplace(skillPackage: SkillPackage): Promise<void> {
    const packageDir = path.join(this.marketplaceDirectory, "packages", skillPackage.metadata.name);
    fs.mkdirSync(packageDir, { recursive: true });
    
    const packagePath = path.join(packageDir, `${skillPackage.metadata.version}.json`);
    fs.writeFileSync(packagePath, JSON.stringify(skillPackage, null, 2));
  }

  private async updateMarketplaceIndex(metadata: SkillMetadata): Promise<void> {
    let entry = this.cache.get(metadata.name);
    
    if (!entry) {
      entry = {
        id: metadata.name,
        metadata,
        versions: [metadata.version],
        latestVersion: metadata.version,
        compatibility: ["1.0.0"],
        requirements: []
      };
    } else {
      // 更新现有条目
      if (!entry.versions.includes(metadata.version)) {
        entry.versions.push(metadata.version);
      }
      entry.latestVersion = metadata.version;
      entry.metadata = metadata;
    }
    
    this.cache.set(metadata.name, entry);
    await this.saveMarketplaceIndex();
  }

  private getCategoryDescription(category: string): string {
    const descriptions: Record<string, string> = {
      "automation": "自动化任务和流程",
      "data": "数据处理和分析",
      "communication": "沟通和通知",
      "productivity": "生产力工具",
      "development": "开发和编程",
      "entertainment": "娱乐和游戏",
      "finance": "财务和金融",
      "health": "健康和健身",
      "education": "教育和学习",
      "general": "通用工具",
      "uncategorized": "未分类"
    };
    
    return descriptions[category] || "未知分类";
  }
}

// 导出全局实例
export const skillMarketplace = SkillMarketplace.getInstance();