/**
 * 技能版本管理系统
 * 提供技能版本控制、回滚和升级功能
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { log, logError } from "../shared/logger.js";
import { JPClawError, ErrorCode } from "../shared/errors.js";
import { metrics } from "../monitoring/metrics.js";

export interface VersionInfo {
  version: string;
  timestamp: number;
  author?: string;
  description?: string;
  changes?: string[];
  hash: string;
  size: number;
}

export interface SkillVersion {
  name: string;
  currentVersion: string;
  versions: VersionInfo[];
  backupPath: string;
}

export interface VersionComparison {
  current: string;
  target: string;
  changeType: "upgrade" | "downgrade" | "same";
  riskLevel: "low" | "medium" | "high";
  compatibility: "compatible" | "breaking" | "unknown";
}

export class SkillVersionManager {
  private static instance: SkillVersionManager;
  private versionsDirectory: string;
  private backupDirectory: string;
  private skillsDirectory: string;

  private constructor() {
    this.versionsDirectory = path.resolve(process.cwd(), "sessions", "skill_versions");
    this.backupDirectory = path.resolve(process.cwd(), "sessions", "skill_backups");
    this.skillsDirectory = path.resolve(process.cwd(), "skills");
    
    // 确保目录存在
    fs.mkdirSync(this.versionsDirectory, { recursive: true });
    fs.mkdirSync(this.backupDirectory, { recursive: true });
  }

  static getInstance(): SkillVersionManager {
    if (!SkillVersionManager.instance) {
      SkillVersionManager.instance = new SkillVersionManager();
    }
    return SkillVersionManager.instance;
  }

  /**
   * 为技能创建新版本
   */
  async createVersion(
    skillName: string,
    versionTag: string,
    description?: string,
    author?: string
  ): Promise<VersionInfo> {
    const skillPath = path.join(this.skillsDirectory, skillName);
    
    if (!fs.existsSync(skillPath)) {
      throw new JPClawError({
        code: ErrorCode.SKILL_NOT_FOUND,
        message: `Skill '${skillName}' not found`
      });
    }

    try {
      // 验证版本格式
      if (!this.isValidVersion(versionTag)) {
        throw new JPClawError({
          code: ErrorCode.INPUT_VALIDATION_FAILED,
          message: `Invalid version format: ${versionTag}. Use semantic versioning (e.g., 1.0.0)`
        });
      }

      // 检查版本是否已存在
      const existingVersions = await this.getSkillVersions(skillName);
      if (existingVersions.versions.some(v => v.version === versionTag)) {
        throw new JPClawError({
          code: ErrorCode.SKILL_EXECUTION_FAILED,
          message: `Version '${versionTag}' already exists for skill '${skillName}'`
        });
      }

      // 创建技能快照
      const snapshot = await this.createSkillSnapshot(skillPath);
      
      // 保存版本信息
      const versionInfo: VersionInfo = {
        version: versionTag,
        timestamp: Date.now(),
        author,
        description,
        changes: await this.detectChanges(skillName, versionTag),
        hash: snapshot.hash,
        size: snapshot.size
      };

      await this.saveSkillVersion(skillName, versionInfo, snapshot.data);

      log("info", "Skill version created", {
        skill: skillName,
        version: versionTag,
        size: snapshot.size,
        author
      });

      metrics.increment("skills.versions.created", 1, {
        skill: skillName,
        version: versionTag
      });

      return versionInfo;
    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.SKILL_EXECUTION_FAILED,
        message: `Failed to create version for skill '${skillName}'`,
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 回滚技能到指定版本
   */
  async rollbackToVersion(skillName: string, targetVersion: string): Promise<{
    success: boolean;
    previousVersion: string;
    restoredFiles: string[];
  }> {
    try {
      const skillVersions = await this.getSkillVersions(skillName);
      const targetVersionInfo = skillVersions.versions.find(v => v.version === targetVersion);
      
      if (!targetVersionInfo) {
        throw new JPClawError({
          code: ErrorCode.SKILL_NOT_FOUND,
          message: `Version '${targetVersion}' not found for skill '${skillName}'`
        });
      }

      // 备份当前版本
      const currentVersion = await this.createVersion(
        skillName,
        `backup-${Date.now()}`,
        "Automatic backup before rollback"
      );

      // 恢复目标版本
      const restored = await this.restoreSkillVersion(skillName, targetVersion);

      // 更新版本记录
      await this.updateCurrentVersion(skillName, targetVersion);

      log("info", "Skill rolled back", {
        skill: skillName,
        fromVersion: skillVersions.currentVersion,
        toVersion: targetVersion,
        backupVersion: currentVersion.version
      });

      metrics.increment("skills.versions.rollback", 1, {
        skill: skillName,
        target_version: targetVersion
      });

      return {
        success: true,
        previousVersion: skillVersions.currentVersion,
        restoredFiles: restored.files
      };

    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.SKILL_EXECUTION_FAILED,
        message: `Failed to rollback skill '${skillName}' to version '${targetVersion}'`,
        cause: error instanceof Error ? error : undefined
      }));

      return {
        success: false,
        previousVersion: "",
        restoredFiles: []
      };
    }
  }

  /**
   * 获取技能的所有版本信息
   */
  async getSkillVersions(skillName: string): Promise<SkillVersion> {
    const versionFile = path.join(this.versionsDirectory, `${skillName}.json`);
    
    if (!fs.existsSync(versionFile)) {
      return {
        name: skillName,
        currentVersion: "1.0.0",
        versions: [],
        backupPath: path.join(this.backupDirectory, skillName)
      };
    }

    try {
      const content = fs.readFileSync(versionFile, 'utf-8');
      return JSON.parse(content) as SkillVersion;
    } catch (error) {
      log("warn", "Failed to load skill versions", {
        skill: skillName,
        error: String(error)
      });
      
      return {
        name: skillName,
        currentVersion: "1.0.0",
        versions: [],
        backupPath: path.join(this.backupDirectory, skillName)
      };
    }
  }

  /**
   * 比较两个版本
   */
  compareVersions(version1: string, version2: string): VersionComparison {
    const v1 = this.parseVersion(version1);
    const v2 = this.parseVersion(version2);
    
    let changeType: "upgrade" | "downgrade" | "same";
    let riskLevel: "low" | "medium" | "high";
    let compatibility: "compatible" | "breaking" | "unknown";

    if (v1.major < v2.major) {
      changeType = "upgrade";
      riskLevel = v2.major - v1.major > 1 ? "high" : "medium";
      compatibility = "breaking";
    } else if (v1.major > v2.major) {
      changeType = "downgrade";
      riskLevel = "high";
      compatibility = "breaking";
    } else if (v1.minor < v2.minor) {
      changeType = "upgrade";
      riskLevel = "medium";
      compatibility = "compatible";
    } else if (v1.minor > v2.minor) {
      changeType = "downgrade";
      riskLevel = "medium";
      compatibility = "compatible";
    } else if (v1.patch < v2.patch) {
      changeType = "upgrade";
      riskLevel = "low";
      compatibility = "compatible";
    } else if (v1.patch > v2.patch) {
      changeType = "downgrade";
      riskLevel = "low";
      compatibility = "compatible";
    } else {
      changeType = "same";
      riskLevel = "low";
      compatibility = "compatible";
    }

    return {
      current: version1,
      target: version2,
      changeType,
      riskLevel,
      compatibility
    };
  }

  /**
   * 获取技能的版本历史
   */
  async getVersionHistory(skillName: string): Promise<{
    versions: VersionInfo[];
    timeline: Array<{
      version: string;
      timestamp: number;
      action: "create" | "rollback" | "upgrade";
      description?: string;
    }>;
  }> {
    const skillVersions = await this.getSkillVersions(skillName);
    
    // 构建时间线
    const timeline = skillVersions.versions
      .map(v => ({
        version: v.version,
        timestamp: v.timestamp,
        action: "create" as const,
        description: v.description
      }))
      .sort((a, b) => b.timestamp - a.timestamp);

    return {
      versions: skillVersions.versions.sort((a, b) => b.timestamp - a.timestamp),
      timeline
    };
  }

  /**
   * 清理旧版本
   */
  async cleanupOldVersions(skillName: string, keepCount: number = 5): Promise<{
    removed: string[];
    kept: string[];
    spaceSaved: number;
  }> {
    const skillVersions = await this.getSkillVersions(skillName);
    const sortedVersions = skillVersions.versions.sort((a, b) => b.timestamp - a.timestamp);
    
    const toKeep = sortedVersions.slice(0, keepCount);
    const toRemove = sortedVersions.slice(keepCount);
    
    let spaceSaved = 0;
    const removed: string[] = [];

    for (const version of toRemove) {
      try {
        const versionPath = path.join(this.backupDirectory, skillName, version.version);
        if (fs.existsSync(versionPath)) {
          const stats = fs.statSync(versionPath);
          spaceSaved += stats.size;
          
          fs.rmSync(versionPath, { recursive: true, force: true });
          removed.push(version.version);
        }
      } catch (error) {
        log("warn", "Failed to remove old version", {
          skill: skillName,
          version: version.version,
          error: String(error)
        });
      }
    }

    // 更新版本文件
    const updatedVersions: SkillVersion = {
      ...skillVersions,
      versions: toKeep
    };
    
    await this.saveSkillVersionFile(skillName, updatedVersions);

    log("info", "Cleaned up old versions", {
      skill: skillName,
      removed: removed.length,
      kept: toKeep.length,
      spaceSavedMB: Math.round(spaceSaved / 1024 / 1024)
    });

    metrics.gauge("skills.versions.cleanup.removed", removed.length, { skill: skillName });

    return {
      removed,
      kept: toKeep.map(v => v.version),
      spaceSaved
    };
  }

  private async createSkillSnapshot(skillPath: string): Promise<{
    data: Buffer;
    hash: string;
    size: number;
  }> {
    const files = this.getAllFiles(skillPath);
    const archive = await this.createTarGz(files, skillPath);
    const hash = createHash('sha256').update(archive).digest('hex');
    
    return {
      data: archive,
      hash,
      size: archive.length
    };
  }

  private getAllFiles(dirPath: string): string[] {
    const files: string[] = [];
    
    const walk = (currentPath: string) => {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        
        if (entry.isDirectory()) {
          walk(fullPath);
        } else {
          files.push(fullPath);
        }
      }
    };
    
    walk(dirPath);
    return files;
  }

  private async createTarGz(files: string[], basePath: string): Promise<Buffer> {
    // 简化的归档实现，实际应该使用 tar 库
    const archive: Record<string, Buffer> = {};
    
    for (const filePath of files) {
      const relativePath = path.relative(basePath, filePath);
      const content = fs.readFileSync(filePath);
      archive[relativePath] = content;
    }
    
    return Buffer.from(JSON.stringify(archive));
  }

  private async saveSkillVersion(
    skillName: string,
    versionInfo: VersionInfo,
    versionData: Buffer
  ): Promise<void> {
    const skillVersions = await this.getSkillVersions(skillName);
    
    // 保存版本数据
    const versionPath = path.join(this.backupDirectory, skillName, versionInfo.version);
    fs.mkdirSync(path.dirname(versionPath), { recursive: true });
    fs.writeFileSync(versionPath, versionData);
    
    // 更新版本记录
    skillVersions.versions.push(versionInfo);
    skillVersions.currentVersion = versionInfo.version;
    
    await this.saveSkillVersionFile(skillName, skillVersions);
  }

  private async saveSkillVersionFile(skillName: string, versions: SkillVersion): Promise<void> {
    const versionFile = path.join(this.versionsDirectory, `${skillName}.json`);
    fs.writeFileSync(versionFile, JSON.stringify(versions, null, 2));
  }

  private async restoreSkillVersion(skillName: string, version: string): Promise<{
    files: string[];
  }> {
    const versionPath = path.join(this.backupDirectory, skillName, version);
    const skillPath = path.join(this.skillsDirectory, skillName);
    
    if (!fs.existsSync(versionPath)) {
      throw new JPClawError({
        code: ErrorCode.SKILL_NOT_FOUND,
        message: `Version data not found for ${skillName}@${version}`
      });
    }

    // 读取版本数据
    const versionData = fs.readFileSync(versionPath);
    const archive = JSON.parse(versionData.toString()) as Record<string, string>;
    
    // 清理现有文件
    if (fs.existsSync(skillPath)) {
      fs.rmSync(skillPath, { recursive: true, force: true });
    }
    
    // 恢复文件
    fs.mkdirSync(skillPath, { recursive: true });
    const restoredFiles: string[] = [];
    
    for (const [relativePath, content] of Object.entries(archive)) {
      const targetPath = path.join(skillPath, relativePath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, Buffer.from(content, 'base64'));
      restoredFiles.push(relativePath);
    }
    
    return { files: restoredFiles };
  }

  private async updateCurrentVersion(skillName: string, version: string): Promise<void> {
    const skillVersions = await this.getSkillVersions(skillName);
    skillVersions.currentVersion = version;
    await this.saveSkillVersionFile(skillName, skillVersions);
  }

  private async detectChanges(skillName: string, newVersion: string): Promise<string[]> {
    // 简化的变更检测，实际应该比较文件内容
    const changes = [
      `Version ${newVersion} created`,
      "Files updated",
      "Dependencies checked"
    ];
    
    return changes;
  }

  private isValidVersion(version: string): boolean {
    const semverRegex = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9-]+)?(?:\+[a-zA-Z0-9-]+)?$/;
    return semverRegex.test(version);
  }

  private parseVersion(version: string): { major: number; minor: number; patch: number } {
    const parts = version.split('.').map(Number);
    return {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0
    };
  }
}

// 导出全局实例
export const skillVersionManager = SkillVersionManager.getInstance();