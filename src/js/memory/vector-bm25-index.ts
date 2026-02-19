/**
 * BM25索引模块 - 为向量记忆提供关键词检索能力
 *
 * 功能：
 * 1. 为MemoryVector建立BM25全文索引
 * 2. 支持按metadata.type过滤检索
 * 3. 与向量搜索融合，提供混合检索
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { log } from "../shared/logger.js";
import type { MemoryVector } from "./vector-store.js";

export interface VectorBM25Hit {
  memoryId: string;
  content: string;
  score: number;
  type: string;
  userId: string;
}

export interface VectorBM25QueryOptions {
  userId?: string;
  type?: string | string[];
  limit?: number;
  minScore?: number;
}

interface SqliteResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class VectorBM25Index {
  private static instance: VectorBM25Index;
  private dbPath: string;
  private isEnabled: boolean;

  private constructor() {
    this.dbPath = path.resolve(
      process.cwd(),
      "sessions",
      "memory_vectors",
      "bm25.sqlite"
    );
    this.isEnabled = this.getEnabledConfig();

    if (this.isEnabled) {
      this.initDatabase();
    }
  }

  static getInstance(): VectorBM25Index {
    if (!VectorBM25Index.instance) {
      VectorBM25Index.instance = new VectorBM25Index();
    }
    return VectorBM25Index.instance;
  }

  private getEnabledConfig(): boolean {
    const raw = process.env.JPCLAW_VECTOR_BM25_ENABLED;
    if (!raw) return true; // 默认启用
    return raw.toLowerCase() === "true" || raw === "1";
  }

  /**
   * 执行SQLite命令
   */
  private async execSql(sql: string, timeout = 5000): Promise<SqliteResult> {
    const bin = process.env.JPCLAW_SQLITE_BIN || "sqlite3";

    return new Promise((resolve) => {
      const child = spawn(bin, ["-batch", "-noheader", this.dbPath], {
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let done = false;
      let timedOut = false;

      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        resolve({ ok, stdout, stderr, timedOut });
      };

      const timer = setTimeout(() => {
        if (done) return;
        timedOut = true;
        child.kill("SIGKILL");
        finish(false);
      }, timeout);

      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });

      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });

      child.on("error", () => finish(false));
      child.on("exit", (code) => {
        clearTimeout(timer);
        finish(code === 0);
      });

      // 写入SQL并关闭stdin
      if (child.stdin) {
        child.stdin.write(sql);
        child.stdin.end();
      } else {
        finish(false);
      }
    });
  }

  /**
   * 初始化数据库和FTS5表
   */
  private initDatabase(): void {
    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // 创建FTS5虚拟表（同步执行）
      // 使用unicode61分词器，适合中英文混合
      // remove_diacritics 0: 保留重音符号（对中文无影响）
      // separators: 指定分隔符
      const sql = `
        PRAGMA journal_mode = WAL;
        CREATE VIRTUAL TABLE IF NOT EXISTS vector_fts USING fts5(
          memoryId UNINDEXED,
          userId UNINDEXED,
          type UNINDEXED,
          content,
          content_raw UNINDEXED,
          importance UNINDEXED,
          timestamp UNINDEXED,
          tokenize = 'unicode61 remove_diacritics 0'
        );
      `;

      // 使用spawnSync同步初始化
      const result = spawnSync("sqlite3", [this.dbPath], {
        input: sql,
        encoding: "utf-8",
        timeout: 5000
      });

      if (result.error || result.status !== 0) {
        throw new Error(result.stderr || "Failed to initialize database");
      }

      log("info", "VectorBM25Index initialized", {
        dbPath: this.dbPath,
        enabled: this.isEnabled
      });
    } catch (error) {
      log("error", "VectorBM25Index initialization failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      this.isEnabled = false;
    }
  }

  /**
   * 转义SQL字符串
   */
  private escapeSql(str: string): string {
    return str.replace(/'/g, "''");
  }

  /**
   * 索引单个记忆向量
   */
  async indexMemory(memory: MemoryVector): Promise<void> {
    if (!this.isEnabled) return;

    try {
      const sql = `
        INSERT OR REPLACE INTO vector_fts (
          memoryId, userId, type, content, content_raw, importance, timestamp
        ) VALUES (
          '${this.escapeSql(memory.id)}',
          '${this.escapeSql(memory.metadata.userId)}',
          '${this.escapeSql(memory.metadata.type)}',
          '${this.escapeSql(memory.content)}',
          '${this.escapeSql(memory.content)}',
          ${memory.metadata.importance || 0.5},
          ${memory.metadata.timestamp}
        );
      `;

      const result = await this.execSql(sql);

      if (!result.ok) {
        throw new Error(result.stderr || "SQL execution failed");
      }

      log("debug", "Memory indexed to VectorBM25", {
        memoryId: memory.id,
        userId: memory.metadata.userId,
        type: memory.metadata.type
      });
    } catch (error) {
      log("warn", "Failed to index memory to VectorBM25", {
        memoryId: memory.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * 批量索引记忆向量
   */
  async indexMemories(memories: MemoryVector[]): Promise<void> {
    if (!this.isEnabled || memories.length === 0) return;

    try {
      const values = memories
        .map(
          (m) => `(
          '${this.escapeSql(m.id)}',
          '${this.escapeSql(m.metadata.userId)}',
          '${this.escapeSql(m.metadata.type)}',
          '${this.escapeSql(m.content)}',
          '${this.escapeSql(m.content)}',
          ${m.metadata.importance || 0.5},
          ${m.metadata.timestamp}
        )`
        )
        .join(",\n");

      const sql = `
        BEGIN TRANSACTION;
        INSERT OR REPLACE INTO vector_fts (
          memoryId, userId, type, content, content_raw, importance, timestamp
        ) VALUES ${values};
        COMMIT;
      `;

      const result = await this.execSql(sql, 30000); // 30秒超时

      if (!result.ok) {
        throw new Error(result.stderr || "Batch insert failed");
      }

      log("info", "Batch indexed memories to VectorBM25", {
        count: memories.length
      });
    } catch (error) {
      log("error", "Failed to batch index memories to VectorBM25", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * 删除记忆索引
   */
  async removeMemory(memoryId: string): Promise<void> {
    if (!this.isEnabled) return;

    try {
      const sql = `DELETE FROM vector_fts WHERE memoryId = '${this.escapeSql(memoryId)}';`;
      const result = await this.execSql(sql);

      if (!result.ok) {
        throw new Error(result.stderr || "Delete failed");
      }

      log("debug", "Memory removed from VectorBM25 index", { memoryId });
    } catch (error) {
      log("warn", "Failed to remove memory from VectorBM25 index", {
        memoryId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * BM25搜索（Fallback: 使用LIKE代替FTS5 MATCH以支持中文）
   */
  async search(query: string, options: VectorBM25QueryOptions = {}): Promise<VectorBM25Hit[]> {
    if (!this.isEnabled) return [];

    try {
      const limit = Math.max(1, Math.min(50, options.limit || 10));
      const minScore = options.minScore || 0;

      // 提取查询关键词（空格分隔）
      const keywords = query.trim().split(/\s+/).filter(k => k.length > 0);

      if (keywords.length === 0) {
        return [];
      }

      // 构建WHERE子句
      const whereClauses: string[] = [];

      // 1. LIKE匹配（支持中文）
      const likeConditions = keywords.map(keyword =>
        `content_raw LIKE '%${this.escapeSql(keyword)}%'`
      ).join(" OR ");

      whereClauses.push(`(${likeConditions})`);

      // 2. userId过滤
      if (options.userId) {
        whereClauses.push(`userId = '${this.escapeSql(options.userId)}'`);
      }

      // 3. type过滤
      if (options.type) {
        const types = Array.isArray(options.type) ? options.type : [options.type];
        const typeList = types.map((t) => `'${this.escapeSql(t)}'`).join(", ");
        whereClauses.push(`type IN (${typeList})`);
      }

      const whereClause = whereClauses.join(" AND ");

      // 查询SQL - 计算匹配关键词数量作为分数
      const sql = `
        SELECT
          memoryId,
          content_raw as content,
          type,
          userId,
          (${keywords.map(k => `CASE WHEN content_raw LIKE '%${this.escapeSql(k)}%' THEN 1 ELSE 0 END`).join(" + ")}) as matchCount
        FROM vector_fts
        WHERE ${whereClause}
        ORDER BY matchCount DESC, importance DESC
        LIMIT ${limit};
      `;

      const result = await this.execSql(sql, 10000); // 10秒超时

      if (!result.ok) {
        throw new Error(result.stderr || "Search failed");
      }

      // 解析结果（格式：memoryId|content|type|userId|matchCount）
      const hits: VectorBM25Hit[] = [];
      const lines = result.stdout.trim().split("\n").filter((line) => line.length > 0);

      for (const line of lines) {
        const parts = line.split("|");
        if (parts.length >= 5) {
          const matchCount = parseInt(parts[4]) || 0;
          const score = matchCount / keywords.length; // 归一化到0-1

          if (score >= minScore) {
            hits.push({
              memoryId: parts[0],
              content: parts[1],
              score,
              type: parts[2],
              userId: parts[3]
            });
          }
        }
      }

      log("debug", "VectorBM25 search completed (LIKE fallback)", {
        query: query.slice(0, 50),
        keywords: keywords.length,
        resultsCount: hits.length,
        userId: options.userId,
        type: options.type
      });

      return hits;
    } catch (error) {
      log("error", "VectorBM25 search failed", {
        query: query.slice(0, 50),
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  /**
   * 重建整个索引（用于数据迁移或修复）
   */
  async rebuildIndex(memories: MemoryVector[]): Promise<void> {
    if (!this.isEnabled) return;

    try {
      log("info", "Rebuilding VectorBM25 index...", {
        memoryCount: memories.length
      });

      // 清空表
      await this.execSql("DELETE FROM vector_fts;");

      // 批量插入
      await this.indexMemories(memories);

      log("info", "VectorBM25 index rebuilt successfully", {
        memoryCount: memories.length
      });
    } catch (error) {
      log("error", "Failed to rebuild VectorBM25 index", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * 获取索引统计
   */
  async getStats(): Promise<{ totalRecords: number; byType: Record<string, number> } | null> {
    if (!this.isEnabled) return null;

    try {
      // 查询总数
      const totalSql = "SELECT COUNT(*) as count FROM vector_fts;";
      const totalResult = await this.execSql(totalSql);
      const totalCount = parseInt(totalResult.stdout.trim()) || 0;

      // 按类型统计
      const typeSql = `
        SELECT type, COUNT(*) as count
        FROM vector_fts
        GROUP BY type;
      `;
      const typeResult = await this.execSql(typeSql);

      const byType: Record<string, number> = {};
      const lines = typeResult.stdout.trim().split("\n").filter((line) => line.length > 0);

      for (const line of lines) {
        const parts = line.split("|");
        if (parts.length >= 2) {
          byType[parts[0]] = parseInt(parts[1]) || 0;
        }
      }

      return {
        totalRecords: totalCount,
        byType
      };
    } catch (error) {
      log("error", "Failed to get VectorBM25 stats", {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }
}

// 导出单例
export const vectorBM25Index = VectorBM25Index.getInstance();
