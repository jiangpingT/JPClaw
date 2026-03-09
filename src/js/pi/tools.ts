import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { runSkill } from "../skills/registry.js";
import { searchWebWithOptions } from "../tools/web.js";

const WORKSPACE_ROOT = path.resolve(process.cwd());
const DEFAULT_MAX_DEPTH = 2;
const MAX_FILE_BYTES = 512 * 1024;
const SEARCH_EXCLUDES = new Set(["node_modules", "dist", "sessions", "log", ".git"]);

function resolveWorkspacePath(inputPath: string): string {
  if (!inputPath) throw new Error("Missing path.");
  const resolved = path.resolve(WORKSPACE_ROOT, inputPath);
  if (resolved === WORKSPACE_ROOT) return resolved;
  if (!resolved.startsWith(`${WORKSPACE_ROOT}${path.sep}`)) {
    throw new Error("Path is خارج的，必须位于 workspace 目录下。");
  }
  return resolved;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function listDirRecursive(
  current: string,
  depth: number,
  maxDepth: number,
  results: string[]
): void {
  if (depth > maxDepth) return;
  const entries = fs.readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    if (SEARCH_EXCLUDES.has(entry.name)) continue;
    const full = path.join(current, entry.name);
    const rel = path.relative(WORKSPACE_ROOT, full) || ".";
    if (entry.isDirectory()) {
      results.push(`${rel}/`);
      listDirRecursive(full, depth + 1, maxDepth, results);
    } else {
      results.push(rel);
    }
  }
}

function searchTextInDir(
  base: string,
  matcher: (content: string) => boolean,
  results: string[],
  maxResults: number
): void {
  if (results.length >= maxResults) return;
  const entries = fs.readdirSync(base, { withFileTypes: true });
  for (const entry of entries) {
    if (results.length >= maxResults) return;
    if (SEARCH_EXCLUDES.has(entry.name)) continue;
    const full = path.join(base, entry.name);
    if (entry.isDirectory()) {
      searchTextInDir(full, matcher, results, maxResults);
      continue;
    }
    try {
      const stat = fs.statSync(full);
      if (stat.size > MAX_FILE_BYTES) continue;
      const content = fs.readFileSync(full, "utf-8");
      if (matcher(content)) {
        results.push(path.relative(WORKSPACE_ROOT, full));
      }
    } catch {
      // Ignore unreadable files.
    }
  }
}

async function execShell(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      { cwd: WORKSPACE_ROOT, timeout: timeoutMs, maxBuffer: 512 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr || error.message || String(error);
          reject(new Error(message.trim() || "Command failed."));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

export type UpdateEnvConfigOptions = {
  key: string;
  value: string;
  comment?: string;
};

export function updateEnvConfig(options: UpdateEnvConfigOptions): {
  key: string;
  updated: boolean;
} {
  const { key, value, comment } = options;

  if (!key || !/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new Error("环境变量名称必须为大写字母、数字和下划线组成，且以字母开头。");
  }

  const envPath = path.resolve(WORKSPACE_ROOT, ".env");
  let envContent = "";

  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, "utf-8");
  }

  const lines = envContent.split("\n");
  let found = false;
  let updated = false;

  // 查找并更新现有的配置
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith(`${key}=`)) {
      const oldValue = line.substring(key.length + 1);
      if (oldValue !== value) {
        lines[i] = `${key}=${value}`;
        updated = true;
      }
      found = true;
      break;
    }
  }

  // 如果没有找到，添加新配置
  if (!found) {
    // 确保文件末尾有空行
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
      lines.push("");
    }

    // 添加注释（如果有）
    if (comment) {
      lines.push(`# ${comment}`);
    }

    lines.push(`${key}=${value}`);
    updated = true;
  }

  if (updated) {
    fs.writeFileSync(envPath, lines.join("\n"));
  }

  return { key, updated };
}

export type CreateSkillTemplateOptions = {
  name: string;
  description?: string;
  overwrite?: boolean;
};

export function createSkillTemplate(options: CreateSkillTemplateOptions): {
  name: string;
} {
  const rawName = String(options.name || "").trim();
  if (!rawName) {
    throw new Error("name 不能为空。");
  }
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(rawName)) {
    throw new Error("name 仅支持字母/数字/-/_，且需以字母或数字开头。");
  }

  const dirPath = resolveWorkspacePath(path.join("skills", rawName));
  const skillPath = path.join(dirPath, "SKILL.md");
  const readmePath = path.join(dirPath, "README.md");
  const overwrite = Boolean(options.overwrite);
  const desc = String(options.description || `Skill ${rawName}`).trim();

  if (!overwrite) {
    if (fs.existsSync(skillPath) || fs.existsSync(readmePath)) {
      throw new Error("技能已存在，若要覆盖请设置 overwrite=true。");
    }
  }

  fs.mkdirSync(dirPath, { recursive: true });
  const template = [
    "---",
    `name: ${rawName}`,
    `description: ${desc.replace(/\\n+/g, " ").trim()}`,
    "---",
    "",
    `# ${rawName}`,
    "",
    "## Purpose",
    "Describe what this skill does and when it should be used.",
    "",
    "## Inputs",
    "List required/optional inputs. If JSON, include the schema.",
    "",
    "## Output",
    "Define the expected output format and any constraints.",
    "",
    "## Steps",
    "1. Step one",
    "2. Step two",
    "",
    "## Guardrails",
    "- Ask for missing required inputs.",
    "- Keep outputs concise.",
    ""
  ].join("\n");
  fs.writeFileSync(skillPath, template);

  const readme = [
    `# ${rawName}`,
    "",
    desc,
    "",
    "## Input",
    "- Use the SKILL.md template to define required inputs.",
    "",
    "## Output",
    "- Define the response format in SKILL.md.",
    "",
    "## Example",
    "```md",
    "---",
    `name: ${rawName}`,
    `description: ${desc.replace(/\\n+/g, " ").trim()}`,
    "---",
    "",
    "# Skill Title",
    "## Purpose",
    "## Inputs",
    "## Output",
    "## Steps",
    "```",
    ""
  ].join("\n");
  fs.writeFileSync(readmePath, readme);

  return { name: rawName };
}


/**
 * 扫描并获取所有可用的 skills
 * 从 skills/ 目录中读取每个 skill 的 SKILL.md 文件
 *
 * 🔑 只注册有真实实现（index.ts/index.js）的 skills
 * 没有实现的 skills（如只有 SKILL.md 的 LLM-based skills）不会被注册为独立工具
 * 这样 LLM 会智能地使用其他工具（如 web_search）完成任务
 */
function getAllSkills(): Array<{ name: string; description: string }> {
  const skills: Array<{ name: string; description: string }> = [];
  const skillsDir = path.resolve(WORKSPACE_ROOT, "skills");

  if (!fs.existsSync(skillsDir)) {
    return skills;
  }

  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("_")) continue; // 跳过 _shared 等特殊目录

      const skillPath = path.join(skillsDir, entry.name, "SKILL.md");

      if (!fs.existsSync(skillPath)) continue;

      // 🔑 检查是否有真实实现
      const implPathTs = path.join(skillsDir, entry.name, "index.ts");
      const implPathJs = path.join(skillsDir, entry.name, "index.js");
      const hasImpl = fs.existsSync(implPathTs) || fs.existsSync(implPathJs);

      if (!hasImpl) {
        console.log(`[Skills] Skipping ${entry.name}: no implementation (LLM-based skill, not registered as tool)`);
        continue;
      }

      try {
        const content = fs.readFileSync(skillPath, "utf-8");

        // 提取 frontmatter 中的 description
        const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
        let description = `Execute ${entry.name} skill`;

        if (frontmatterMatch) {
          const frontmatter = frontmatterMatch[1];
          const descMatch = frontmatter.match(/description:\s*(.+)/);
          if (descMatch) {
            description = descMatch[1].trim();
          }
        }

        skills.push({
          name: entry.name,
          description
        });

        console.log(`[Skills] Registered ${entry.name} as tool (has implementation)`);
      } catch (error) {
        // 跳过读取失败的 skill
        console.warn(`Failed to read skill ${entry.name}:`, error);
      }
    }
  } catch (error) {
    console.warn("Failed to scan skills directory:", error);
  }

  console.log(`[Skills] Total registered tools: ${skills.length}`);
  return skills;
}

export function createPiTools(): AgentTool<any>[] {
  const baseTools = [
    {
      name: "read_file",
      label: "Read File",
      description: "Read a UTF-8 text file from the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to workspace." }
        },
        required: ["path"]
      } as any,
      execute: async (_toolCallId: string, params: any) => {
        const filePath = resolveWorkspacePath(params.path);
        const content = fs.readFileSync(filePath, "utf-8");
        return {
          content: [{ type: "text" as const, text: content }],
          details: { path: params.path }
        };
      }
    },
    {
      name: "write_file",
      label: "Write File",
      description: "Write UTF-8 text to a file (creates directories if needed).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to workspace." },
          content: { type: "string", description: "File contents." }
        },
        required: ["path", "content"]
      } as any,
      execute: async (_toolCallId: string, params: any) => {
        const filePath = resolveWorkspacePath(params.path);
        ensureParentDir(filePath);
        fs.writeFileSync(filePath, params.content ?? "");
        return {
          content: [{ type: "text" as const, text: "ok" }],
          details: { path: params.path }
        };
      }
    },
    {
      name: "edit_file",
      label: "Edit File",
      description: "Replace text in a file. Provide oldText and newText.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to workspace." },
          oldText: { type: "string", description: "Text to replace." },
          newText: { type: "string", description: "Replacement text." },
          replaceAll: { type: "boolean", description: "Replace all occurrences." }
        },
        required: ["path", "oldText", "newText"]
      } as any,
      execute: async (_toolCallId: string, params: any) => {
        const filePath = resolveWorkspacePath(params.path);
        const content = fs.readFileSync(filePath, "utf-8");
        if (!params.oldText) {
          throw new Error("oldText 不能为空。");
        }
        if (!content.includes(params.oldText)) {
          throw new Error("oldText 未匹配到文件内容。");
        }
        const next = params.replaceAll
          ? content.split(params.oldText).join(params.newText)
          : content.replace(params.oldText, params.newText);
        fs.writeFileSync(filePath, next);
        return {
          content: [{ type: "text" as const, text: "ok" }],
          details: { path: params.path }
        };
      }
    },
    {
      name: "list_dir",
      label: "List Dir",
      description: "List files and folders (optionally recursive).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to workspace." },
          recursive: { type: "boolean", description: "List recursively." },
          maxDepth: { type: "number", description: "Max recursion depth." }
        },
        required: ["path"]
      } as any,
      execute: async (_toolCallId: string, params: any) => {
        const dirPath = resolveWorkspacePath(params.path);
        const results: string[] = [];
        if (params.recursive) {
          const depth = Number(params.maxDepth ?? DEFAULT_MAX_DEPTH);
          listDirRecursive(dirPath, 0, depth, results);
        } else {
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          for (const entry of entries) {
            if (SEARCH_EXCLUDES.has(entry.name)) continue;
            results.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
          }
        }
        return {
          content: [{ type: "text" as const, text: results.join("\n") }],
          details: { path: params.path, count: results.length }
        };
      }
    },
    {
      name: "search_text",
      label: "Search Text",
      description: "Search text in files under a directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Base directory relative to workspace." },
          pattern: { type: "string", description: "Text or regex pattern." },
          regex: { type: "boolean", description: "Treat pattern as regex." },
          caseSensitive: { type: "boolean", description: "Case sensitive search." },
          maxResults: { type: "number", description: "Max results." }
        },
        required: ["path", "pattern"]
      } as any,
      execute: async (_toolCallId: string, params: any) => {
        const base = resolveWorkspacePath(params.path);
        const maxResults = Number(params.maxResults ?? 50);
        const flags = params.caseSensitive ? "g" : "gi";
        const matcher = params.regex
          ? (content: string) => new RegExp(params.pattern, flags).test(content)
          : (content: string) =>
              params.caseSensitive
                ? content.includes(params.pattern)
                : content.toLowerCase().includes(String(params.pattern).toLowerCase());
        const results: string[] = [];
        searchTextInDir(base, matcher, results, maxResults);
        return {
          content: [{ type: "text" as const, text: results.join("\n") }],
          details: { path: params.path, count: results.length }
        };
      }
    },
    {
      name: "run_shell",
      label: "Run Shell",
      description: "Run a shell command in workspace root.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute." },
          timeoutMs: { type: "number", description: "Timeout in ms." }
        },
        required: ["command"]
      } as any,
      execute: async (_toolCallId: string, params: any) => {
        const timeoutMs = Number(params.timeoutMs ?? 15000);
        const { stdout, stderr } = await execShell(params.command, timeoutMs);
        const output = [stdout?.trim(), stderr?.trim()].filter(Boolean).join("\n");
        return {
          content: [{ type: "text" as const, text: output || "ok" }],
          details: { command: params.command }
        };
      }
    },
    {
      name: "run_skill",
      label: "Run Skill",
      description: "运行 JPClaw 技能。只能执行有真实实现代码（index.ts/index.js）的技能。对于没有专用技能的任务（如天气查询），请使用其他工具如 web_search 代替。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "技能名称" },
          input: { type: "string", description: "技能输入" },
          scope: { type: "string", description: "可选范围：skills 或 agents" }
        },
        required: ["name"]
      } as any,
      execute: async (_toolCallId: string, params: any) => {
        // 🔑 检查 skill 是否有实现
        const skillsDir = path.resolve(WORKSPACE_ROOT, "skills");
        const implPathTs = path.join(skillsDir, params.name, "index.ts");
        const implPathJs = path.join(skillsDir, params.name, "index.js");
        const hasImpl = fs.existsSync(implPathTs) || fs.existsSync(implPathJs);

        if (!hasImpl) {
          // 对于无实现的 skill，返回友好提示
          return {
            content: [{
              type: "text" as const,
              text: `技能 '${params.name}' 没有实现代码（仅 LLM-based skill）。对于需要实时数据或外部 API 的任务，请使用 web_search 等其他工具代替。`
            }],
            details: { name: params.name, hasImplementation: false }
          };
        }

        const output = await runSkill(params.name, params.input || "", { scope: params.scope });
        return {
          content: [{ type: "text" as const, text: output }],
          details: { name: params.name, hasImplementation: true }
        };
      }
    },
    {
      name: "create_skill_template",
      label: "Create Skill Template",
      description: "Create a new SKILL.md template under skills/<name>/.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill folder/name (kebab-case recommended)." },
          description: { type: "string", description: "Short description for SKILL.md frontmatter." },
          overwrite: { type: "boolean", description: "Overwrite existing files." }
        },
        required: ["name"]
      } as any,
      execute: async (_toolCallId: string, params: any) => {
        const { name } = createSkillTemplate({
          name: params.name,
          description: params.description,
          overwrite: params.overwrite
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `created skills/${name}/SKILL.md, skills/${name}/README.md`
            }
          ],
          details: { name }
        };
      }
    },
    {
      name: "web_search",
      label: "Web Search",
      description: "Search the web for current information, news, and facts. Use this when you need up-to-date information or when the user asks about current events, news, people, companies, or any information not in your knowledge base.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." }
        },
        required: ["query"]
      } as any,
      execute: async (_toolCallId: string, params: any) => {
        const result = await searchWebWithOptions(params.query, { traceId: _toolCallId });
        return {
          content: [{ type: "text" as const, text: result }],
          details: { query: params.query }
        };
      }
    },
    {
      name: "update_env_config",
      label: "Update Environment Config",
      description: "添加或更新项目 .env 文件中的环境变量配置。用于配置 API Keys、服务地址等。配置会立即写入 .env 文件，但需要重启服务才能生效。",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "环境变量名称（大写字母、数字、下划线，例如：AMAP_API_KEY）"
          },
          value: {
            type: "string",
            description: "环境变量的值"
          },
          comment: {
            type: "string",
            description: "可选的注释说明（会作为 # 注释添加到 .env 中）"
          }
        },
        required: ["key", "value"]
      } as any,
      execute: async (_toolCallId: string, params: any) => {
        const { key, updated } = updateEnvConfig({
          key: params.key,
          value: params.value,
          comment: params.comment
        });

        const message = updated
          ? `已${fs.existsSync(path.resolve(WORKSPACE_ROOT, ".env")) ? "更新" : "添加"} ${key} 到 .env 文件`
          : `${key} 已存在且值相同，无需更新`;

        return {
          content: [
            {
              type: "text" as const,
              text: `${message}\n\n⚠️ 提示：环境变量配置已写入 .env 文件，但需要重启服务才能生效。\n建议：npm run restart`
            }
          ],
          details: { key, updated }
        };
      }
    },
    {
      name: "discover_peers",
      label: "Discover Peer Bots",
      description: "查看所有同伴 Bot 的能力卡片（specialties / notGoodAt / channels）。在决定是否向同伴求助之前，先调用此工具了解他们的专长，再用 peer-ask skill 发出请求。",
      parameters: {
        type: "object",
        properties: {}
      } as any,
      execute: async (_toolCallId: string, _params: any) => {
        const botsDir = path.resolve(WORKSPACE_ROOT, "bots");
        if (!fs.existsSync(botsDir)) {
          return {
            content: [{ type: "text" as const, text: "暂无同伴 Bot 信息（bots/ 目录不存在）" }],
            details: { count: 0 }
          };
        }
        const cards: unknown[] = [];
        for (const entry of fs.readdirSync(botsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const cardPath = path.join(botsDir, entry.name, "card.json");
          if (!fs.existsSync(cardPath)) continue;
          try {
            cards.push(JSON.parse(fs.readFileSync(cardPath, "utf-8")));
          } catch { /* skip malformed cards */ }
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(cards, null, 2) }],
          details: { count: cards.length }
        };
      }
    }
  ];

  // 🔑 动态注册所有 skills 为独立工具
  const allSkills = getAllSkills();
  const skillTools: AgentTool<any>[] = allSkills.map(skill => ({
    name: skill.name,
    label: `${skill.name.charAt(0).toUpperCase()}${skill.name.slice(1)} Skill`,
    description: skill.description,
    parameters: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: "Input or query for the skill. For weather: city name(s), can be multiple cities separated by commas (e.g., '北京' or '北京,天津')."
        }
      },
      required: []
    } as any,
    execute: async (_toolCallId: string, params: any) => {
      const input = params.input || "";
      const output = await runSkill(skill.name, input, { scope: "skills" });
      return {
        content: [{ type: "text" as const, text: output }],
        details: { skillName: skill.name, input }
      };
    }
  }));

  return [...baseTools, ...skillTools];
}
