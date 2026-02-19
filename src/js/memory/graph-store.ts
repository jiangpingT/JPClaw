/**
 * 图存储层 - SQLite持久化
 * 管理实体和关系的CRUD操作
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { log, logError } from "../shared/logger.js";
import { JPClawError, ErrorCode } from "../shared/errors.js";
import { safePromiseAll } from "../shared/async-utils.js";
import { sanitizePath, escapeSqlString as secureEscapeSqlString } from "../shared/security-utils.js";
import type {
  GraphEntity,
  GraphRelation,
  EntityType,
  RelationType,
  EntityQueryFilter,
  RelationQueryFilter,
  GraphStatistics
} from "./knowledge-graph-types.js";

// ========== SQLite执行辅助函数 ==========

type Task<T> = () => Promise<T>;
const sqliteQueue = Promise.resolve();
let currentQueue = sqliteQueue;

function enqueueSqlite<T>(task: Task<T>): Promise<T> {
  const run = currentQueue.then(task, task);
  currentQueue = run.then(() => undefined, () => undefined);
  return run;
}

function sqlite3Bin(): string {
  return (process.env.JPCLAW_SQLITE3_BIN || "sqlite3").trim() || "sqlite3";
}

function graphDbPath(): string {
  const raw = process.env.JPCLAW_GRAPH_DB_PATH;
  if (raw && raw.trim()) {
    // P1-9修复: 验证路径，防止路径遍历攻击
    const baseDir = process.cwd();
    const sanitized = sanitizePath(raw.trim(), baseDir);
    if (!sanitized) {
      log("warn", "security.invalid_graph_db_path", {
        path: raw.trim(),
        fallback: "sessions/memory/graph.sqlite"
      });
      return path.resolve(process.cwd(), "sessions", "memory", "graph.sqlite");
    }
    return sanitized;
  }
  return path.resolve(process.cwd(), "sessions", "memory", "graph.sqlite");
}

// P1-9修复: 使用安全的 SQL 转义函数（从 security-utils 导入）
// 保留本地别名以兼容现有代码
function escapeSqlString(text: string): string {
  return secureEscapeSqlString(text);
}

async function runSqlAsync(
  sql: string,
  timeoutMs: number = 5000
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const db = graphDbPath();
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const bin = sqlite3Bin();

  return await new Promise((resolve) => {
    const child = spawn(bin, ["-batch", "-separator", "\t", db], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve({ ok, stdout, stderr });
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish(false);
    }, timeoutMs);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => {
      clearTimeout(timer);
      stderr += String(err);
      finish(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });

    try {
      child.stdin.write(sql, "utf-8");
      child.stdin.end();
    } catch (err) {
      clearTimeout(timer);
      stderr += String(err);
      finish(false);
    }
  });
}

// ========== GraphStore类 ==========

export class GraphStore {
  private static instance: GraphStore;
  private dbPath: string;
  private initialized = false;

  private constructor() {
    this.dbPath = graphDbPath();
  }

  static getInstance(): GraphStore {
    if (!GraphStore.instance) {
      GraphStore.instance = new GraphStore();
    }
    return GraphStore.instance;
  }

  /**
   * 初始化数据库
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const schema = `
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA foreign_keys=ON;

      -- 实体表
      CREATE TABLE IF NOT EXISTS graph_entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        properties TEXT DEFAULT '{}',
        aliases TEXT DEFAULT '[]',
        confidence REAL DEFAULT 0.5,
        source_memory_id TEXT,
        source_timestamp INTEGER,
        user_id TEXT NOT NULL,
        access_count INTEGER DEFAULT 0,
        last_accessed INTEGER,
        importance REAL DEFAULT 0.5,
        created_at INTEGER,
        updated_at INTEGER
      );

      -- 关系表
      CREATE TABLE IF NOT EXISTS graph_relations (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        type TEXT NOT NULL,
        properties TEXT DEFAULT '{}',
        confidence REAL DEFAULT 0.5,
        start_time INTEGER,
        end_time INTEGER,
        timestamp INTEGER,
        source_memory_id TEXT,
        user_id TEXT NOT NULL,
        created_at INTEGER,
        FOREIGN KEY (source_id) REFERENCES graph_entities(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES graph_entities(id) ON DELETE CASCADE
      );

      -- 实体索引
      CREATE INDEX IF NOT EXISTS idx_entities_user ON graph_entities(user_id);
      CREATE INDEX IF NOT EXISTS idx_entities_name ON graph_entities(name);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON graph_entities(user_id, type);
      CREATE INDEX IF NOT EXISTS idx_entities_user_name ON graph_entities(user_id, name);

      -- 关系索引
      CREATE INDEX IF NOT EXISTS idx_relations_source ON graph_relations(source_id);
      CREATE INDEX IF NOT EXISTS idx_relations_target ON graph_relations(target_id);
      CREATE INDEX IF NOT EXISTS idx_relations_type ON graph_relations(user_id, type);
      CREATE INDEX IF NOT EXISTS idx_relations_pair ON graph_relations(source_id, target_id);
    `;

    const result = await runSqlAsync(schema, 10000);

    if (!result.ok) {
      logError(new JPClawError({
        code: ErrorCode.MEMORY_OPERATION_FAILED,
        message: "Failed to initialize graph database",
        cause: new Error(result.stderr)
      }));
      throw new Error("Graph database initialization failed");
    }

    this.initialized = true;
    log("info", "Graph database initialized", { dbPath: this.dbPath });
  }

  // ========== 实体操作 ==========

  /**
   * 添加实体
   */
  async addEntity(entity: GraphEntity): Promise<string> {
    await this.initialize();

    const sql = `
      INSERT OR REPLACE INTO graph_entities (
        id, name, type, properties, aliases, confidence,
        source_memory_id, source_timestamp, user_id,
        access_count, last_accessed, importance, created_at, updated_at
      ) VALUES (
        '${escapeSqlString(entity.id)}',
        '${escapeSqlString(entity.name)}',
        '${escapeSqlString(entity.type)}',
        '${escapeSqlString(JSON.stringify(entity.properties))}',
        '${escapeSqlString(JSON.stringify(entity.aliases))}',
        ${entity.confidence},
        '${escapeSqlString(entity.source.memoryId)}',
        ${entity.source.timestamp},
        '${escapeSqlString(entity.metadata.userId)}',
        ${entity.metadata.accessCount},
        ${entity.metadata.lastAccessed},
        ${entity.metadata.importance},
        ${Date.now()},
        ${Date.now()}
      );
    `;

    return enqueueSqlite(async () => {
      const result = await runSqlAsync(sql);
      if (!result.ok) {
        throw new Error(`Failed to add entity: ${result.stderr}`);
      }
      return entity.id;
    });
  }

  /**
   * 获取实体
   */
  async getEntity(id: string): Promise<GraphEntity | null> {
    await this.initialize();

    const sql = `SELECT * FROM graph_entities WHERE id = '${escapeSqlString(id)}';`;

    return enqueueSqlite(async () => {
      const result = await runSqlAsync(sql);
      if (!result.ok || !result.stdout.trim()) {
        return null;
      }

      const rows = this.parseTabularOutput(result.stdout);
      if (rows.length === 0) return null;

      return this.parseEntityRow(rows[0]);
    });
  }

  /**
   * 按名称查找实体
   */
  async findEntitiesByName(name: string, userId: string): Promise<GraphEntity[]> {
    await this.initialize();

    const sql = `
      SELECT * FROM graph_entities
      WHERE user_id = '${escapeSqlString(userId)}'
        AND (name = '${escapeSqlString(name)}' OR aliases LIKE '%${escapeSqlString(name)}%')
      ORDER BY confidence DESC;
    `;

    return enqueueSqlite(async () => {
      const result = await runSqlAsync(sql);
      if (!result.ok || !result.stdout.trim()) {
        return [];
      }

      const rows = this.parseTabularOutput(result.stdout);
      return rows.map(row => this.parseEntityRow(row));
    });
  }

  /**
   * 按类型查找实体
   */
  async findEntitiesByType(type: EntityType, userId: string): Promise<GraphEntity[]> {
    await this.initialize();

    const sql = `
      SELECT * FROM graph_entities
      WHERE user_id = '${escapeSqlString(userId)}' AND type = '${escapeSqlString(type)}'
      ORDER BY importance DESC, confidence DESC;
    `;

    return enqueueSqlite(async () => {
      const result = await runSqlAsync(sql);
      if (!result.ok || !result.stdout.trim()) {
        return [];
      }

      const rows = this.parseTabularOutput(result.stdout);
      return rows.map(row => this.parseEntityRow(row));
    });
  }

  /**
   * 查询实体
   */
  async queryEntities(filter: EntityQueryFilter): Promise<GraphEntity[]> {
    await this.initialize();

    const conditions: string[] = [`user_id = '${escapeSqlString(filter.userId)}'`];

    if (filter.name) {
      conditions.push(`name LIKE '%${escapeSqlString(filter.name)}%'`);
    }
    if (filter.type) {
      conditions.push(`type = '${escapeSqlString(filter.type)}'`);
    }
    if (filter.minConfidence !== undefined) {
      conditions.push(`confidence >= ${filter.minConfidence}`);
    }
    if (filter.minImportance !== undefined) {
      conditions.push(`importance >= ${filter.minImportance}`);
    }

    const sql = `
      SELECT * FROM graph_entities
      WHERE ${conditions.join(" AND ")}
      ORDER BY importance DESC, confidence DESC
      ${filter.limit ? `LIMIT ${filter.limit}` : ""};
    `;

    return enqueueSqlite(async () => {
      const result = await runSqlAsync(sql);
      if (!result.ok || !result.stdout.trim()) {
        return [];
      }

      const rows = this.parseTabularOutput(result.stdout);
      return rows.map(row => this.parseEntityRow(row));
    });
  }

  /**
   * 获取所有实体
   */
  async getAllEntities(userId: string): Promise<GraphEntity[]> {
    await this.initialize();

    const sql = `SELECT * FROM graph_entities WHERE user_id = '${escapeSqlString(userId)}';`;

    return enqueueSqlite(async () => {
      const result = await runSqlAsync(sql);
      if (!result.ok || !result.stdout.trim()) {
        return [];
      }

      const rows = this.parseTabularOutput(result.stdout);
      return rows.map(row => this.parseEntityRow(row));
    });
  }

  /**
   * 删除实体
   */
  async deleteEntity(id: string): Promise<boolean> {
    await this.initialize();

    const sql = `DELETE FROM graph_entities WHERE id = '${escapeSqlString(id)}';`;

    return enqueueSqlite(async () => {
      const result = await runSqlAsync(sql);
      return result.ok;
    });
  }

  // ========== 关系操作 ==========

  /**
   * 添加关系
   */
  async addRelation(relation: GraphRelation): Promise<string> {
    await this.initialize();

    const sql = `
      INSERT OR REPLACE INTO graph_relations (
        id, source_id, target_id, type, properties, confidence,
        start_time, end_time, timestamp, source_memory_id, user_id, created_at
      ) VALUES (
        '${escapeSqlString(relation.id)}',
        '${escapeSqlString(relation.sourceId)}',
        '${escapeSqlString(relation.targetId)}',
        '${escapeSqlString(relation.type)}',
        '${escapeSqlString(JSON.stringify(relation.properties))}',
        ${relation.confidence},
        ${relation.temporal.startTime || "NULL"},
        ${relation.temporal.endTime || "NULL"},
        ${relation.temporal.timestamp},
        '${escapeSqlString(relation.source.memoryId)}',
        '${escapeSqlString(relation.source.userId)}',
        ${Date.now()}
      );
    `;

    return enqueueSqlite(async () => {
      const result = await runSqlAsync(sql);
      if (!result.ok) {
        throw new Error(`Failed to add relation: ${result.stderr}`);
      }
      return relation.id;
    });
  }

  /**
   * 获取关系
   */
  async getRelation(id: string): Promise<GraphRelation | null> {
    await this.initialize();

    const sql = `SELECT * FROM graph_relations WHERE id = '${escapeSqlString(id)}';`;

    return enqueueSqlite(async () => {
      const result = await runSqlAsync(sql);
      if (!result.ok || !result.stdout.trim()) {
        return null;
      }

      const rows = this.parseTabularOutput(result.stdout);
      if (rows.length === 0) return null;

      return this.parseRelationRow(rows[0]);
    });
  }

  /**
   * 按实体查找关系
   */
  async findRelationsByEntity(
    entityId: string,
    direction: "out" | "in" | "both" = "both"
  ): Promise<GraphRelation[]> {
    await this.initialize();

    let sql = "";
    if (direction === "out") {
      sql = `SELECT * FROM graph_relations WHERE source_id = '${escapeSqlString(entityId)}';`;
    } else if (direction === "in") {
      sql = `SELECT * FROM graph_relations WHERE target_id = '${escapeSqlString(entityId)}';`;
    } else {
      sql = `SELECT * FROM graph_relations WHERE source_id = '${escapeSqlString(entityId)}' OR target_id = '${escapeSqlString(entityId)}';`;
    }

    return enqueueSqlite(async () => {
      const result = await runSqlAsync(sql);
      if (!result.ok || !result.stdout.trim()) {
        return [];
      }

      const rows = this.parseTabularOutput(result.stdout);
      return rows.map(row => this.parseRelationRow(row));
    });
  }

  /**
   * 按类型查找关系
   */
  async findRelationsByType(type: RelationType, userId: string): Promise<GraphRelation[]> {
    await this.initialize();

    const sql = `SELECT * FROM graph_relations WHERE user_id = '${escapeSqlString(userId)}' AND type = '${escapeSqlString(type)}';`;

    return enqueueSqlite(async () => {
      const result = await runSqlAsync(sql);
      if (!result.ok || !result.stdout.trim()) {
        return [];
      }

      const rows = this.parseTabularOutput(result.stdout);
      return rows.map(row => this.parseRelationRow(row));
    });
  }

  /**
   * 查询关系
   */
  async queryRelations(filter: RelationQueryFilter): Promise<GraphRelation[]> {
    await this.initialize();

    const conditions: string[] = [`user_id = '${escapeSqlString(filter.userId)}'`];

    if (filter.sourceId) {
      conditions.push(`source_id = '${escapeSqlString(filter.sourceId)}'`);
    }
    if (filter.targetId) {
      conditions.push(`target_id = '${escapeSqlString(filter.targetId)}'`);
    }
    if (filter.type) {
      conditions.push(`type = '${escapeSqlString(filter.type)}'`);
    }
    if (filter.minConfidence !== undefined) {
      conditions.push(`confidence >= ${filter.minConfidence}`);
    }

    const sql = `
      SELECT * FROM graph_relations
      WHERE ${conditions.join(" AND ")}
      ${filter.limit ? `LIMIT ${filter.limit}` : ""};
    `;

    return enqueueSqlite(async () => {
      const result = await runSqlAsync(sql);
      if (!result.ok || !result.stdout.trim()) {
        return [];
      }

      const rows = this.parseTabularOutput(result.stdout);
      return rows.map(row => this.parseRelationRow(row));
    });
  }

  /**
   * 获取所有关系
   */
  async getAllRelations(userId: string): Promise<GraphRelation[]> {
    await this.initialize();

    const sql = `SELECT * FROM graph_relations WHERE user_id = '${escapeSqlString(userId)}';`;

    return enqueueSqlite(async () => {
      const result = await runSqlAsync(sql);
      if (!result.ok || !result.stdout.trim()) {
        return [];
      }

      const rows = this.parseTabularOutput(result.stdout);
      return rows.map(row => this.parseRelationRow(row));
    });
  }

  /**
   * 删除关系
   */
  async deleteRelation(id: string): Promise<boolean> {
    await this.initialize();

    const sql = `DELETE FROM graph_relations WHERE id = '${escapeSqlString(id)}';`;

    return enqueueSqlite(async () => {
      const result = await runSqlAsync(sql);
      return result.ok;
    });
  }

  // ========== 统计 ==========

  /**
   * 获取统计信息
   */
  async getStatistics(userId: string): Promise<GraphStatistics> {
    await this.initialize();

    const countSql = `
      SELECT
        (SELECT COUNT(*) FROM graph_entities WHERE user_id = '${escapeSqlString(userId)}') as entity_count,
        (SELECT COUNT(*) FROM graph_relations WHERE user_id = '${escapeSqlString(userId)}') as relation_count;
    `;

    const entityTypesSql = `
      SELECT type, COUNT(*) as count
      FROM graph_entities
      WHERE user_id = '${escapeSqlString(userId)}'
      GROUP BY type;
    `;

    const relationTypesSql = `
      SELECT type, COUNT(*) as count
      FROM graph_relations
      WHERE user_id = '${escapeSqlString(userId)}'
      GROUP BY type;
    `;

    return enqueueSqlite(async () => {
      // P0-1修复: 使用 safePromiseAll 添加超时保护（默认5秒）
      const results = await safePromiseAll([
        runSqlAsync(countSql),
        runSqlAsync(entityTypesSql),
        runSqlAsync(relationTypesSql)
      ], 10000); // SQL查询允许10秒超时

      const countResult = results[0].status === 'fulfilled' ? results[0].value : { ok: false, stdout: '', stderr: '' };
      const entityTypesResult = results[1].status === 'fulfilled' ? results[1].value : { ok: false, stdout: '', stderr: '' };
      const relationTypesResult = results[2].status === 'fulfilled' ? results[2].value : { ok: false, stdout: '', stderr: '' };

      let entityCount = 0;
      let relationCount = 0;

      if (countResult.ok && countResult.stdout.trim()) {
        const rows = this.parseTabularOutput(countResult.stdout);
        if (rows.length > 0) {
          entityCount = parseInt(rows[0].entity_count || "0");
          relationCount = parseInt(rows[0].relation_count || "0");
        }
      }

      const byEntityType: Partial<Record<EntityType, number>> = {};
      if (entityTypesResult.ok && entityTypesResult.stdout.trim()) {
        const rows = this.parseTabularOutput(entityTypesResult.stdout);
        for (const row of rows) {
          byEntityType[row.type as EntityType] = parseInt(row.count || "0");
        }
      }

      const byRelationType: Partial<Record<RelationType, number>> = {};
      if (relationTypesResult.ok && relationTypesResult.stdout.trim()) {
        const rows = this.parseTabularOutput(relationTypesResult.stdout);
        for (const row of rows) {
          byRelationType[row.type as RelationType] = parseInt(row.count || "0");
        }
      }

      return {
        entityCount,
        relationCount,
        byEntityType,
        byRelationType
      };
    });
  }

  // ========== 辅助方法 ==========

  private parseTabularOutput(output: string): Array<Record<string, string>> {
    const lines = output.trim().split("\n");
    if (lines.length === 0) return [];

    // 第一行是列名
    const headers = lines[0].split("\t");
    const rows: Array<Record<string, string>> = [];

    // 后续行是数据
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split("\t");
      const row: Record<string, string> = {};

      for (let j = 0; j < headers.length; j++) {
        row[headers[j]] = values[j] || "";
      }

      rows.push(row);
    }

    return rows;
  }

  private parseEntityRow(row: Record<string, string>): GraphEntity {
    return {
      id: row.id,
      name: row.name,
      type: row.type as EntityType,
      properties: JSON.parse(row.properties || "{}"),
      aliases: JSON.parse(row.aliases || "[]"),
      confidence: parseFloat(row.confidence || "0.5"),
      source: {
        memoryId: row.source_memory_id,
        timestamp: parseInt(row.source_timestamp || "0")
      },
      metadata: {
        userId: row.user_id,
        accessCount: parseInt(row.access_count || "0"),
        lastAccessed: parseInt(row.last_accessed || "0"),
        importance: parseFloat(row.importance || "0.5")
      }
    };
  }

  private parseRelationRow(row: Record<string, string>): GraphRelation {
    return {
      id: row.id,
      sourceId: row.source_id,
      targetId: row.target_id,
      type: row.type as RelationType,
      properties: JSON.parse(row.properties || "{}"),
      confidence: parseFloat(row.confidence || "0.5"),
      temporal: {
        startTime: row.start_time ? parseInt(row.start_time) : undefined,
        endTime: row.end_time ? parseInt(row.end_time) : undefined,
        timestamp: parseInt(row.timestamp || "0")
      },
      source: {
        memoryId: row.source_memory_id,
        userId: row.user_id
      }
    };
  }
}

export const graphStore = GraphStore.getInstance();
