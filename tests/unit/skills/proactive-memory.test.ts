/**
 * proactive-memory 单元测试
 *
 * 覆盖：loadProjectSuggestions / saveProjectSuggestions
 * 重点验证：建议去重、30天截断、多项目隔离、文件损坏降级
 */
import { describe, it, expect, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  loadProjectSuggestions,
  saveProjectSuggestions,
} from "../../../skills/_shared/proactive-utils.js";

// ─── 辅助：与实现保持一致的 slug 计算（SHA-256）────────────────────────────────

function projectSlug(projectPath: string): string {
  return crypto.createHash("sha256").update(projectPath).digest("hex").slice(0, 40);
}

const MEMORY_DIR = path.resolve(
  process.cwd(),
  "sessions",
  "brain",
  "proactive-memory"
);

function memoryFilePath(projectPath: string): string {
  return path.join(MEMORY_DIR, `${projectSlug(projectPath)}.json`);
}

// ─── 每次测试使用独立 projectPath，避免互相干扰 ──────────────────────────────

const BASE = `/tmp/test-proactive-memory-${Date.now()}`;
let counter = 0;
function freshProject(): string {
  return `${BASE}-${counter++}`;
}

// 清理测试产生的文件
const created: string[] = [];
afterEach(() => {
  for (const f of created.splice(0)) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
});

function track(projectPath: string): string {
  created.push(memoryFilePath(projectPath));
  return projectPath;
}

// ─── 基础读写 ─────────────────────────────────────────────────────────────────

describe("loadProjectSuggestions", () => {
  it("文件不存在时返回空数组", () => {
    const proj = freshProject(); // 故意不 track（文件不会被创建）
    expect(loadProjectSuggestions(proj)).toEqual([]);
  });

  it("JSON 文件损坏时降级返回空数组，不抛出", () => {
    const proj = track(freshProject());
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(memoryFilePath(proj), "{ broken json ~~~");

    expect(() => loadProjectSuggestions(proj)).not.toThrow();
    expect(loadProjectSuggestions(proj)).toEqual([]);
  });
});

describe("saveProjectSuggestions + loadProjectSuggestions 往返", () => {
  it("首次保存后能完整读取", () => {
    const proj = track(freshProject());
    saveProjectSuggestions(proj, ["测试覆盖率不足", "缺少错误处理"]);

    const result = loadProjectSuggestions(proj);
    expect(result).toContain("测试覆盖率不足");
    expect(result).toContain("缺少错误处理");
    expect(result).toHaveLength(2);
  });

  it("空数组输入时不写文件，不抛出", () => {
    const proj = track(freshProject());
    expect(() => saveProjectSuggestions(proj, [])).not.toThrow();
    expect(fs.existsSync(memoryFilePath(proj))).toBe(false);
  });
});

// ─── 去重逻辑（核心场景）─────────────────────────────────────────────────────

describe("建议去重", () => {
  it("同标题多次 save 只保留一条", () => {
    const proj = track(freshProject());
    saveProjectSuggestions(proj, ["测试覆盖率不足"]);
    saveProjectSuggestions(proj, ["测试覆盖率不足"]); // 重复
    saveProjectSuggestions(proj, ["测试覆盖率不足", "新发现"]);

    const result = loadProjectSuggestions(proj);
    const duplicates = result.filter((t) => t === "测试覆盖率不足");
    expect(duplicates).toHaveLength(1);
    expect(result).toContain("新发现");
    expect(result).toHaveLength(2);
  });

  it("save 新标题时不影响已有不同标题", () => {
    const proj = track(freshProject());
    saveProjectSuggestions(proj, ["A", "B"]);
    saveProjectSuggestions(proj, ["B", "C"]); // B 已有，C 是新的

    const result = loadProjectSuggestions(proj);
    expect(result).toContain("A");
    expect(result).toContain("B");
    expect(result).toContain("C");
    expect(result).toHaveLength(3);
  });
});

// ─── 30 天截断 ────────────────────────────────────────────────────────────────

describe("30 天滚动窗口", () => {
  it("load 时过滤掉超过 30 天的建议", () => {
    const proj = track(freshProject());
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(
      memoryFilePath(proj),
      JSON.stringify({
        projectPath: proj,
        suggestions: [
          { title: "过期建议", date: oldDate },
          { title: "新鲜建议", date: today },
        ],
      })
    );

    const result = loadProjectSuggestions(proj);
    expect(result).not.toContain("过期建议");
    expect(result).toContain("新鲜建议");
    expect(result).toHaveLength(1);
  });

  it("save 时自动淘汰超过 30 天的旧记录，不再写回", () => {
    const proj = track(freshProject());
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(
      memoryFilePath(proj),
      JSON.stringify({
        projectPath: proj,
        suggestions: [{ title: "过期的旧建议", date: oldDate }],
      })
    );

    saveProjectSuggestions(proj, ["今日新建议"]);

    const data = JSON.parse(fs.readFileSync(memoryFilePath(proj), "utf-8"));
    const titles = data.suggestions.map((s: { title: string }) => s.title);
    expect(titles).not.toContain("过期的旧建议");
    expect(titles).toContain("今日新建议");
  });

  it("恰好 30 天前的建议保留，31 天的被过滤", () => {
    const proj = track(freshProject());
    const exactly30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const over31 = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(
      memoryFilePath(proj),
      JSON.stringify({
        projectPath: proj,
        suggestions: [
          { title: "边界建议", date: exactly30 },
          { title: "超期建议", date: over31 },
        ],
      })
    );

    const result = loadProjectSuggestions(proj);
    expect(result).toContain("边界建议");
    expect(result).not.toContain("超期建议");
  });
});

// ─── 多项目隔离 ───────────────────────────────────────────────────────────────

describe("多项目隔离", () => {
  it("不同 projectPath 使用不同文件，互不干扰", () => {
    const projA = track(freshProject());
    const projB = track(freshProject());

    saveProjectSuggestions(projA, ["A 项目的问题"]);
    saveProjectSuggestions(projB, ["B 项目的问题"]);

    expect(loadProjectSuggestions(projA)).toContain("A 项目的问题");
    expect(loadProjectSuggestions(projA)).not.toContain("B 项目的问题");
    expect(loadProjectSuggestions(projB)).toContain("B 项目的问题");
    expect(loadProjectSuggestions(projB)).not.toContain("A 项目的问题");
  });

  it("两个相近路径产生不同 slug（无碰撞）", () => {
    const projA = track("/Users/mlamp/Workspace/JPClaw");
    const projB = track("/Users/mlamp/Workspace/JPClaw2");

    saveProjectSuggestions(projA, ["JPClaw 独有问题"]);
    saveProjectSuggestions(projB, ["JPClaw2 独有问题"]);

    expect(loadProjectSuggestions(projA)).not.toContain("JPClaw2 独有问题");
    expect(loadProjectSuggestions(projB)).not.toContain("JPClaw 独有问题");
  });
});

// ─── 文件 Schema 验证 ─────────────────────────────────────────────────────────

describe("持久化文件结构", () => {
  it("写入的 JSON 包含 projectPath、suggestions 数组、日期格式正确", () => {
    const proj = track(freshProject());
    saveProjectSuggestions(proj, ["架构改进建议"]);

    const data = JSON.parse(fs.readFileSync(memoryFilePath(proj), "utf-8"));
    expect(data).toHaveProperty("projectPath", proj);
    expect(Array.isArray(data.suggestions)).toBe(true);
    expect(data.suggestions[0]).toMatchObject({
      title: "架构改进建议",
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  it("MEMORY_DIR 不存在时 save 自动创建目录", () => {
    // 用一个不存在的子项目路径，其 slug 文件必然不存在
    const proj = track(freshProject());
    // 如果 MEMORY_DIR 不存在会报错，save 应处理这种情况
    expect(() => saveProjectSuggestions(proj, ["test"])).not.toThrow();
    expect(fs.existsSync(memoryFilePath(proj))).toBe(true);
  });
});
