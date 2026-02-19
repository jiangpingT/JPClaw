import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../shared/config.js";
import { resolveProvider } from "../providers/index.js";
import type { AgentMessage } from "../core/messages.js";
import { log } from "../shared/logger.js";
import { skillSandbox } from "../security/sandbox.js";

export type SkillManifest = {
  name: string;
  description?: string;
  scope: "skills" | "agents";
  kind: "skill" | "doc";
  path: string;
};

type ExecutableSkillManifest = {
  name: string;
  description?: string;
  entry: string;
  permissions?: string[];
};

export type LoadedSkill = {
  manifest: SkillManifest;
  prompt: string;
  filePath: string;
};

const DEFAULT_SKILLS_DIR = "skills";
const AGENT_SKILLS_DIR = path.join(".agents", "skills");

export function listSkills(rootDir = DEFAULT_SKILLS_DIR, scope: "skills" | "agents" = "skills"): LoadedSkill[] {
  if (!fs.existsSync(rootDir)) return [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const skills: LoadedSkill[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillFile = resolveSkillFile(rootDir, entry.name);
      if (!skillFile) continue;
      const fullPath = path.join(rootDir, entry.name, skillFile);
      try {
        const { manifest, body } = parseSkillMarkdown(fullPath, entry.name, scope, "skill");
        skills.push({
          manifest,
          prompt: buildSkillPrompt(manifest, body),
          filePath: fullPath
        });
      } catch (error) {
        log("warn", "skills.manifest.invalid", { skill: entry.name, error: String(error) });
      }
      continue;
    }
    if (scope === "agents" && entry.isFile() && entry.name.toLowerCase() === "pr_workflow.md") {
      const fullPath = path.join(rootDir, entry.name);
      try {
        const { manifest, body } = parseSkillMarkdown(fullPath, "PR_WORKFLOW", scope, "doc");
        skills.push({
          manifest,
          prompt: body,
          filePath: fullPath
        });
      } catch (error) {
        log("warn", "skills.doc.invalid", { file: entry.name, error: String(error) });
      }
    }
  }
  return skills;
}

export function listAgentSkills(): LoadedSkill[] {
  return listSkills(AGENT_SKILLS_DIR, "agents");
}

export async function runSkill(
  name: string,
  input: string,
  options: { scope?: "skills" | "agents" } = {}
): Promise<string> {
  const resolved = resolveSkillByName(name, options.scope);
  if (!resolved) {
    throw new Error(`Skill not found: ${name}`);
  }
  if (resolved.manifest.kind === "doc") {
    return resolved.prompt;
  }

  const impl = resolveSkillImplementation(resolved);
  if (impl) {
    return await runSkillImplementation(impl, input);
  }

  const provider = resolveProvider(loadConfig());
  if (!provider) {
    throw new Error("No provider configured for SKILL.md execution.");
  }
  const messages: AgentMessage[] = [
    { role: "system", content: resolved.prompt },
    { role: "user", content: input || "" }
  ];
  const response = await provider.generate(messages);
  return response.text;
}

function resolveSkillByName(
  rawName: string,
  scope?: "skills" | "agents"
): LoadedSkill | null {
  const normalized = normalizeSkillRef(rawName, scope);
  if (!normalized) return null;
  let { name, scope: inferredScope } = normalized;

  const skills = inferredScope === "agents" ? listAgentSkills() : listSkills();
  const hit = skills.find((item) => item.manifest.name === name);
  if (hit) return hit;
  if (inferredScope === "skills") {
    return listAgentSkills().find((item) => item.manifest.name === name) || null;
  }
  return listSkills().find((item) => item.manifest.name === name) || null;
}

function normalizeSkillRef(
  rawName: string,
  scope?: "skills" | "agents"
): { name: string; scope: "skills" | "agents" } | null {
  const trimmed = String(rawName || "").trim();
  if (!trimmed) return null;
  let inferredScope: "skills" | "agents" = scope || "skills";
  let name = trimmed;
  if (trimmed.startsWith("skills/")) {
    inferredScope = "skills";
    name = trimmed.slice("skills/".length);
  } else if (trimmed.startsWith("agents/")) {
    inferredScope = "agents";
    name = trimmed.slice("agents/".length);
  } else if (trimmed.startsWith("agent:")) {
    inferredScope = "agents";
    name = trimmed.slice("agent:".length);
  }
  return { name, scope: inferredScope };
}

function resolveSkillFile(rootDir: string, dirName: string): string | null {
  const candidates = ["SKILL.md", "skill.md"];
  for (const file of candidates) {
    const full = path.join(rootDir, dirName, file);
    if (fs.existsSync(full)) return file;
  }
  return null;
}

type SkillImplementation = { name: string; dir: string; entry: string };

function resolveSkillImplementation(resolved: LoadedSkill): SkillImplementation | null {
  const dir = path.dirname(resolved.filePath);
  const manifestPath = path.join(dir, "skill.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const raw = fs.readFileSync(manifestPath, "utf-8");
      const manifest = JSON.parse(raw) as { entry?: string };
      if (manifest?.entry) {
        return { name: resolved.manifest.name, dir, entry: String(manifest.entry) };
      }
    } catch (error) {
      log("warn", "skills.executable.invalid", { skill: resolved.manifest.name, error: String(error) });
    }
  }
  const indexJs = path.join(dir, "index.js");
  if (fs.existsSync(indexJs)) {
    return { name: resolved.manifest.name, dir, entry: "index.js" };
  }
  return null;
}

async function runSkillImplementation(impl: SkillImplementation, input: string): Promise<string> {
  const entryPath = path.resolve(impl.dir, impl.entry);
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Skill entry not found: ${entryPath}`);
  }

  // 检查是否启用沙箱模式
  const sandboxEnabled = process.env.JPCLAW_SKILL_SANDBOX === "true";
  
  if (sandboxEnabled) {
    // 使用沙箱执行
    const result = await skillSandbox.executeSkill(impl.name, entryPath, input);
    
    if (!result.success) {
      throw new Error(`Skill execution failed: ${result.error || "Unknown error"}`);
    }
    
    log("info", "Skill executed in sandbox", {
      skill: impl.name,
      durationMs: result.stats.durationMs,
      memoryUsedMB: result.stats.memoryUsedMB
    });
    
    return result.output;
  } else {
    // 直接执行（不安全模式，仅用于开发）
    log("warn", "Skill executed without sandbox", { skill: impl.name });
    
    const moduleUrl = pathToFileURL(entryPath).href;
    const mod = await import(moduleUrl);
    const handler = mod.run || mod.default;
    if (!handler) {
      throw new Error(`Skill entry missing export: ${impl.name}`);
    }
    const result = await handler(input);
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  }
}

function parseSkillMarkdown(
  fullPath: string,
  fallbackName: string,
  scope: "skills" | "agents",
  kind: "skill" | "doc"
): { manifest: SkillManifest; body: string } {
  const raw = fs.readFileSync(fullPath, "utf-8");
  const { frontmatter, body } = splitFrontmatter(raw);
  const name = frontmatter.name || fallbackName;
  const description = frontmatter.description || undefined;
  const manifest: SkillManifest = {
    name,
    description,
    scope,
    kind,
    path: fullPath
  };
  return { manifest, body };
}

function splitFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }
  const lines = trimmed.split(/\r?\n/);
  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    return { frontmatter: {}, body: content };
  }
  const fmLines = lines.slice(1, endIndex);
  const frontmatter: Record<string, string> = {};
  for (const line of fmLines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) frontmatter[key] = value;
  }
  const body = lines.slice(endIndex + 1).join("\n").trimStart();
  return { frontmatter, body };
}

function buildSkillPrompt(manifest: SkillManifest, body: string): string {
  const header = [
    `你正在执行技能：${manifest.name}`,
    manifest.description ? `技能描述：${manifest.description}` : "",
    "",
    "请严格遵循技能说明完成任务，直接给出最终结果。",
    ""
  ]
    .filter(Boolean)
    .join("\n");
  return `${header}\n${body}`.trim();
}
