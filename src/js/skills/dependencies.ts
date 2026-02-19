/**
 * 技能依赖管理系统
 * 提供技能依赖解析、版本控制和依赖图管理
 */

import fs from "node:fs";
import path from "node:path";
import { log, logError } from "../shared/logger.js";
import { JPClawError, ErrorCode } from "../shared/errors.js";
import { metrics } from "../monitoring/metrics.js";

export interface SkillDependency {
  name: string;
  version?: string;
  required: boolean;
  type: "skill" | "system" | "package";
  location?: string;
}

export interface SkillManifestV2 {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  dependencies?: SkillDependency[];
  systemRequirements?: {
    nodeVersion?: string;
    pythonVersion?: string;
    platforms?: string[];
    memory?: string;
    storage?: string;
  };
  permissions?: {
    network?: boolean;
    filesystem?: "none" | "read" | "write";
    environment?: string[];
  };
  entry: string;
  tags?: string[];
  category?: string;
  priority?: number;
}

export interface DependencyNode {
  name: string;
  version: string;
  dependencies: string[];
  dependents: string[];
  installed: boolean;
  path?: string;
  manifest?: SkillManifestV2;
}

export interface DependencyGraph {
  nodes: Map<string, DependencyNode>;
  resolved: string[];
  unresolved: string[];
  circular: string[][];
}

export class SkillDependencyManager {
  private static instance: SkillDependencyManager;
  private dependencyCache = new Map<string, DependencyNode>();
  private skillsDirectory: string;
  private systemSkillsDirectory: string;

  private constructor() {
    this.skillsDirectory = path.resolve(process.cwd(), "skills");
    this.systemSkillsDirectory = path.resolve(process.cwd(), ".agents", "skills");
  }

  static getInstance(): SkillDependencyManager {
    if (!SkillDependencyManager.instance) {
      SkillDependencyManager.instance = new SkillDependencyManager();
    }
    return SkillDependencyManager.instance;
  }

  /**
   * 扫描所有技能并构建依赖图
   */
  async buildDependencyGraph(): Promise<DependencyGraph> {
    const graph: DependencyGraph = {
      nodes: new Map(),
      resolved: [],
      unresolved: [],
      circular: []
    };

    try {
      // 扫描用户技能
      await this.scanSkillsDirectory(this.skillsDirectory, graph, "user");
      
      // 扫描系统技能
      await this.scanSkillsDirectory(this.systemSkillsDirectory, graph, "system");
      
      // 解析依赖关系
      this.resolveDependencies(graph);
      
      // 检测循环依赖
      this.detectCircularDependencies(graph);
      
      log("info", "Dependency graph built", {
        totalNodes: graph.nodes.size,
        resolved: graph.resolved.length,
        unresolved: graph.unresolved.length,
        circular: graph.circular.length
      });

      metrics.gauge("skills.dependency_graph.nodes", graph.nodes.size);
      metrics.gauge("skills.dependency_graph.unresolved", graph.unresolved.length);
      metrics.gauge("skills.dependency_graph.circular", graph.circular.length);

      return graph;
    } catch (error) {
      logError(new JPClawError({
        code: ErrorCode.SKILL_DEPENDENCY_MISSING,
        message: "Failed to build dependency graph",
        cause: error instanceof Error ? error : undefined
      }));
      throw error;
    }
  }

  /**
   * 获取技能的执行顺序（拓扑排序）
   */
  getExecutionOrder(skillNames: string[]): string[] {
    const graph = this.buildSimpleGraph(skillNames);
    return this.topologicalSort(graph);
  }

  /**
   * 检查技能依赖是否满足
   */
  async validateSkillDependencies(skillName: string): Promise<{
    valid: boolean;
    missing: SkillDependency[];
    issues: string[];
  }> {
    const issues: string[] = [];
    const missing: SkillDependency[] = [];

    try {
      const manifest = await this.loadSkillManifest(skillName);
      if (!manifest || !manifest.dependencies) {
        return { valid: true, missing: [], issues: [] };
      }

      for (const dep of manifest.dependencies) {
        const validation = await this.validateSingleDependency(dep, manifest.name);
        
        if (!validation.satisfied) {
          if (dep.required) {
            missing.push(dep);
            issues.push(`Required dependency '${dep.name}' is missing: ${validation.reason}`);
          } else {
            issues.push(`Optional dependency '${dep.name}' is missing: ${validation.reason}`);
          }
        }
      }

      return {
        valid: missing.length === 0,
        missing,
        issues
      };

    } catch (error) {
      const issue = `Failed to validate dependencies: ${error instanceof Error ? error.message : String(error)}`;
      return {
        valid: false,
        missing: [],
        issues: [issue]
      };
    }
  }

  /**
   * 安装技能依赖
   */
  async installDependencies(skillName: string): Promise<{
    success: boolean;
    installed: string[];
    failed: Array<{ name: string; error: string }>;
  }> {
    const result = {
      success: false,
      installed: [] as string[],
      failed: [] as Array<{ name: string; error: string }>
    };

    try {
      const manifest = await this.loadSkillManifest(skillName);
      if (!manifest || !manifest.dependencies) {
        return { ...result, success: true };
      }

      for (const dep of manifest.dependencies) {
        if (!dep.required) continue;

        try {
          const installed = await this.installSingleDependency(dep);
          if (installed) {
            result.installed.push(dep.name);
          }
        } catch (error) {
          result.failed.push({
            name: dep.name,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      result.success = result.failed.length === 0;
      
      if (result.success) {
        metrics.increment("skills.dependencies.install.success", 1, { skill: skillName });
      } else {
        metrics.increment("skills.dependencies.install.failed", 1, { skill: skillName });
      }

      return result;

    } catch (error) {
      result.failed.push({
        name: skillName,
        error: error instanceof Error ? error.message : String(error)
      });
      return result;
    }
  }

  /**
   * 获取技能信息
   */
  async getSkillInfo(skillName: string): Promise<{
    manifest?: SkillManifestV2;
    dependencies: SkillDependency[];
    dependents: string[];
    installed: boolean;
  }> {
    try {
      const manifest = await this.loadSkillManifest(skillName);
      const dependents = this.findSkillDependents(skillName);
      const skillPath = this.findSkillPath(skillName);

      return {
        manifest: manifest || undefined,
        dependencies: manifest?.dependencies || [],
        dependents,
        installed: !!skillPath
      };
    } catch (error) {
      return {
        dependencies: [],
        dependents: [],
        installed: false
      };
    }
  }

  private async scanSkillsDirectory(
    directory: string,
    graph: DependencyGraph,
    type: "user" | "system"
  ): Promise<void> {
    if (!fs.existsSync(directory)) return;

    const entries = fs.readdirSync(directory, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillPath = path.join(directory, entry.name);
      const manifest = await this.loadSkillManifestFromPath(skillPath);
      
      if (manifest) {
        const node: DependencyNode = {
          name: manifest.name,
          version: manifest.version,
          dependencies: manifest.dependencies?.map(d => d.name) || [],
          dependents: [],
          installed: true,
          path: skillPath,
          manifest
        };

        graph.nodes.set(manifest.name, node);
        this.dependencyCache.set(manifest.name, node);
      }
    }
  }

  private async loadSkillManifest(skillName: string): Promise<SkillManifestV2 | null> {
    const skillPath = this.findSkillPath(skillName);
    if (!skillPath) return null;

    return this.loadSkillManifestFromPath(skillPath);
  }

  private async loadSkillManifestFromPath(skillPath: string): Promise<SkillManifestV2 | null> {
    const manifestPath = path.join(skillPath, "skill.json");
    
    if (!fs.existsSync(manifestPath)) {
      // 尝试从 SKILL.md 提取基础信息
      return this.extractManifestFromMarkdown(skillPath);
    }

    try {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(content) as SkillManifestV2;
      
      // 验证必需字段
      if (!manifest.name || !manifest.version || !manifest.entry) {
        log("warn", "Invalid skill manifest", { path: manifestPath, manifest });
        return null;
      }

      return manifest;
    } catch (error) {
      log("error", "Failed to load skill manifest", { 
        path: manifestPath, 
        error: String(error) 
      });
      return null;
    }
  }

  private extractManifestFromMarkdown(skillPath: string): SkillManifestV2 | null {
    const mdPath = path.join(skillPath, "SKILL.md");
    if (!fs.existsSync(mdPath)) return null;

    try {
      const content = fs.readFileSync(mdPath, 'utf-8');
      const lines = content.split('\n');
      
      let name = path.basename(skillPath);
      let description = "";
      
      // 提取名称和描述
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        if (line.startsWith('---')) {
          // 解析 frontmatter
          const frontmatter = this.parseFrontmatter(lines, i);
          if (frontmatter.name) name = frontmatter.name;
          if (frontmatter.description) description = frontmatter.description;
          break;
        }
      }

      // 确定入口文件
      const entryFile = fs.existsSync(path.join(skillPath, "index.js")) ? "index.js" :
                       fs.existsSync(path.join(skillPath, "skill.py")) ? "skill.py" :
                       fs.existsSync(path.join(skillPath, "run.sh")) ? "run.sh" : "SKILL.md";

      return {
        name,
        version: "1.0.0",
        description,
        entry: entryFile,
        dependencies: []
      };
    } catch (error) {
      return null;
    }
  }

  private parseFrontmatter(lines: string[], startIndex: number): Record<string, string> {
    const frontmatter: Record<string, string> = {};
    
    for (let i = startIndex + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '---') break;
      
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.slice(0, colonIndex).trim();
        const value = line.slice(colonIndex + 1).trim();
        frontmatter[key] = value;
      }
    }
    
    return frontmatter;
  }

  private findSkillPath(skillName: string): string | null {
    const userPath = path.join(this.skillsDirectory, skillName);
    if (fs.existsSync(userPath)) return userPath;

    const systemPath = path.join(this.systemSkillsDirectory, skillName);
    if (fs.existsSync(systemPath)) return systemPath;

    return null;
  }

  private findSkillDependents(skillName: string): string[] {
    const dependents: string[] = [];
    
    for (const node of this.dependencyCache.values()) {
      if (node.dependencies.includes(skillName)) {
        dependents.push(node.name);
      }
    }
    
    return dependents;
  }

  private resolveDependencies(graph: DependencyGraph): void {
    for (const [nodeName, node] of graph.nodes) {
      let allResolved = true;
      
      for (const depName of node.dependencies) {
        if (!graph.nodes.has(depName)) {
          allResolved = false;
          if (!graph.unresolved.includes(depName)) {
            graph.unresolved.push(depName);
          }
        } else {
          // 添加反向依赖关系
          const depNode = graph.nodes.get(depName)!;
          if (!depNode.dependents.includes(nodeName)) {
            depNode.dependents.push(nodeName);
          }
        }
      }
      
      if (allResolved) {
        graph.resolved.push(nodeName);
      }
    }
  }

  private detectCircularDependencies(graph: DependencyGraph): void {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    
    for (const nodeName of graph.nodes.keys()) {
      if (!visited.has(nodeName)) {
        const cycle = this.dfsDetectCycle(graph, nodeName, visited, recursionStack, []);
        if (cycle) {
          graph.circular.push(cycle);
        }
      }
    }
  }

  private dfsDetectCycle(
    graph: DependencyGraph,
    nodeName: string,
    visited: Set<string>,
    recursionStack: Set<string>,
    path: string[]
  ): string[] | null {
    visited.add(nodeName);
    recursionStack.add(nodeName);
    path.push(nodeName);
    
    const node = graph.nodes.get(nodeName);
    if (!node) return null;
    
    for (const depName of node.dependencies) {
      if (!visited.has(depName)) {
        const cycle = this.dfsDetectCycle(graph, depName, visited, recursionStack, [...path]);
        if (cycle) return cycle;
      } else if (recursionStack.has(depName)) {
        // 找到循环
        const cycleStart = path.indexOf(depName);
        return path.slice(cycleStart).concat([depName]);
      }
    }
    
    recursionStack.delete(nodeName);
    return null;
  }

  private buildSimpleGraph(skillNames: string[]): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    
    for (const skillName of skillNames) {
      const node = this.dependencyCache.get(skillName);
      if (node) {
        graph.set(skillName, node.dependencies.filter(dep => skillNames.includes(dep)));
      } else {
        graph.set(skillName, []);
      }
    }
    
    return graph;
  }

  private topologicalSort(graph: Map<string, string[]>): string[] {
    const inDegree = new Map<string, number>();
    const result: string[] = [];
    const queue: string[] = [];
    
    // 初始化入度
    for (const node of graph.keys()) {
      inDegree.set(node, 0);
    }
    
    for (const [node, deps] of graph) {
      for (const dep of deps) {
        inDegree.set(dep, (inDegree.get(dep) || 0) + 1);
      }
    }
    
    // 找到入度为0的节点
    for (const [node, degree] of inDegree) {
      if (degree === 0) {
        queue.push(node);
      }
    }
    
    // 拓扑排序
    while (queue.length > 0) {
      const node = queue.shift()!;
      result.push(node);
      
      const deps = graph.get(node) || [];
      for (const dep of deps) {
        const newDegree = (inDegree.get(dep) || 0) - 1;
        inDegree.set(dep, newDegree);
        
        if (newDegree === 0) {
          queue.push(dep);
        }
      }
    }
    
    return result;
  }

  private async validateSingleDependency(
    dep: SkillDependency,
    skillName: string
  ): Promise<{ satisfied: boolean; reason?: string }> {
    switch (dep.type) {
      case "skill":
        const skillExists = this.findSkillPath(dep.name) !== null;
        return {
          satisfied: skillExists,
          reason: skillExists ? undefined : `Skill '${dep.name}' not found`
        };
        
      case "system":
        return this.validateSystemDependency(dep);
        
      case "package":
        return this.validatePackageDependency(dep);
        
      default:
        return {
          satisfied: false,
          reason: `Unknown dependency type: ${dep.type}`
        };
    }
  }

  private validateSystemDependency(dep: SkillDependency): { satisfied: boolean; reason?: string } {
    // 简化的系统依赖检查
    const systemCommands: Record<string, string> = {
      "node": "node --version",
      "python": "python --version",
      "python3": "python3 --version",
      "git": "git --version",
      "curl": "curl --version"
    };
    
    const command = systemCommands[dep.name];
    if (!command) {
      return {
        satisfied: false,
        reason: `Unknown system dependency: ${dep.name}`
      };
    }
    
    // TODO: 实际执行命令检查
    return { satisfied: true };
  }

  private validatePackageDependency(dep: SkillDependency): { satisfied: boolean; reason?: string } {
    // 简化的包依赖检查
    try {
      require.resolve(dep.name);
      return { satisfied: true };
    } catch {
      return {
        satisfied: false,
        reason: `Package '${dep.name}' not found`
      };
    }
  }

  private async installSingleDependency(dep: SkillDependency): Promise<boolean> {
    // 简化的依赖安装逻辑
    // 在实际实现中，这里应该根据依赖类型执行相应的安装命令
    log("info", "Installing dependency", { name: dep.name, type: dep.type });
    
    switch (dep.type) {
      case "skill":
        // TODO: 从技能市场或 Git 仓库安装技能
        return false;
        
      case "package":
        // TODO: 使用 npm 或 pip 安装包
        return false;
        
      default:
        return false;
    }
  }
}

// 导出全局实例
export const skillDependencyManager = SkillDependencyManager.getInstance();