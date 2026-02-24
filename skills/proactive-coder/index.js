/**
 * Proactive Coder (主动型程序员) Skill
 *
 * AI 驱动的项目夜间值班程序员。
 * 扫描项目状态 → AI 自主判断改进项 → 在安全边界内执行 → 创建 Draft PR → Discord 通知。
 */

import fs from "node:fs";
import path from "node:path";
import {
  sh, safeExec, todayString, isPathSafe,
  callAnthropicJSON, sendToDiscord, sendToTelegram,
  loadProjectSuggestions, saveProjectSuggestions,
} from "../_shared/proactive-utils.js";

// ─── 配置 ────────────────────────────────────────────────────────────────────

const DEFAULT_CHANNEL_ID = process.env.DEFAULT_DISCORD_CHANNEL_ID;
const DEFAULT_DEPTH = "standard";

// 安全边界：禁止操作的文件模式（精确匹配）
const FORBIDDEN_PATTERNS = [
  /(?:^|\/)\.env(?:\.|$)/i,
  /(?:^|\/)credentials(?:\.|\/|$)/i,
  /(?:^|\/)\.npmrc$/i,
  /(?:^|\/)\.ssh\//i,
  /(?:^|\/)secrets?\//i,
  /(?:^|\/)\.github\/workflows/i,
  /(?:^|\/)\.gitlab-ci/i,
  /(?:^|\/)Jenkinsfile/i,
  /(?:^|\/)docker-compose.*\.ya?ml/i,
  /(?:^|\/)Dockerfile/i,
];

// 关键文件列表（用于项目上下文收集）
const CONTEXT_FILES = [
  "CLAUDE.md", "ARCHITECTURE.md", "README.md",
  "package.json", "tsconfig.json", "CHANGELOG.md", "mission.md",
];

const DEPTH_LOG_LIMIT = { quick: 5, standard: 15, deep: 30 };

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function isForbiddenFile(filePath) {
  return FORBIDDEN_PATTERNS.some((re) => re.test(filePath));
}

// ─── 项目扫描 ────────────────────────────────────────────────────────────────

async function scanProject(projectPath, depth) {
  const logLimit = DEPTH_LOG_LIMIT[depth] || DEPTH_LOG_LIMIT.standard;
  const cwd = projectPath;

  const [gitStatus, gitLog, gitDiff, gitBranch, gitRemote] =
    await Promise.allSettled([
      sh("git status --short", { cwd }),
      sh(`git log --oneline -${logLimit} --no-decorate`, { cwd }),
      sh("git diff --stat HEAD~3..HEAD", { cwd, allowFail: true }),
      sh("git branch --show-current", { cwd }),
      sh("git remote get-url origin", { cwd, allowFail: true }),
    ]);

  const contextFiles = {};
  for (const fileName of CONTEXT_FILES) {
    const filePath = path.join(projectPath, fileName);
    try {
      if (fs.existsSync(filePath)) {
        contextFiles[fileName] = fs.readFileSync(filePath, "utf-8").slice(0, 3000);
      }
    } catch {}
  }

  const statusOutput = gitStatus.status === "fulfilled" ? gitStatus.value : "";

  return {
    projectPath,
    currentBranch: gitBranch.status === "fulfilled" ? gitBranch.value : "unknown",
    remoteUrl: gitRemote.status === "fulfilled" ? gitRemote.value : "unknown",
    gitStatus: statusOutput,
    gitLog: gitLog.status === "fulfilled" ? gitLog.value : "",
    gitDiff: gitDiff.status === "fulfilled" ? gitDiff.value : "",
    hasUncommittedChanges: statusOutput.length > 0,
    contextFiles,
  };
}

// ─── AI 分析 ─────────────────────────────────────────────────────────────────

async function analyzeWithAI(projectScan, depth, recentSuggestions = []) {
  const depthInstruction = {
    quick: "只看最明显的问题，最多给出 2 个行动建议。",
    standard: "全面审查，给出 3-5 个行动建议。",
    deep: "深入分析每个细节，给出尽可能多的改进建议。",
  };

  const systemPrompt = `你是「阿策」，一个 AI 驱动的夜间值班程序员。你的角色是在项目所有者休息时，审视项目状态并做出有价值的改进。

## 你的工作原则

1. **只做有把握的改进** - 不确定的事情创建 Issue 讨论，不要直接改
2. **优先级排序**：P0 bug修复 > P1 代码质量 > P2 文档完善 > P3 性能优化
3. **安全第一** - 绝不修改 .env、凭证文件、CI/CD 配置
4. **最小改动** - 每个改动保持聚焦，不要一次改太多
5. **清晰说明** - 每个行动都要有明确的理由

## 分析深度

${depthInstruction[depth] || depthInstruction.standard}

## 你可以做的事情

- **修复代码问题**：明确的 bug、类型错误、未处理的边界情况
- **改进代码质量**：减少重复代码、改善命名、简化复杂逻辑
- **完善文档**：更新过时文档、补充缺失说明、修复文档错误
- **添加测试**：为未覆盖的关键路径添加测试
- **清理代码**：删除死代码、未使用的导入、过时的注释

## 你不能做的事情

- 修改 .env 或任何凭证文件
- 修改 CI/CD 配置（GitHub Actions、GitLab CI 等）
- 修改 Dockerfile 或 docker-compose
- 引入新的依赖包
- 做大规模重构
- 修改核心架构

## 输出格式

【重要】只输出纯 JSON，第一个字符必须是 {，最后一个字符必须是 }，不要任何前缀文字、解释或 markdown 标记：

{
  "summary": "一句话总结项目当前状态",
  "actions": [
    {
      "type": "fix" | "improve" | "docs" | "test" | "issue",
      "priority": "P0" | "P1" | "P2" | "P3",
      "title": "简短标题",
      "description": "详细描述要做什么以及为什么",
      "files": [
        {
          "path": "相对文件路径",
          "action": "create" | "modify",
          "content": "完整的文件内容"
        }
      ]
    }
  ],
  "issues": [
    {
      "title": "Issue 标题",
      "body": "Issue 详细描述",
      "labels": ["bug" | "enhancement" | "documentation"]
    }
  ],
  "skipReason": "如果没有值得改进的地方，说明原因"
}`;

  const contextParts = [];
  contextParts.push(`## 项目路径\n${projectScan.projectPath}`);
  contextParts.push(`## 当前分支\n${projectScan.currentBranch}`);

  if (projectScan.hasUncommittedChanges) {
    contextParts.push(
      `## ⚠️ 工作区状态（有未提交的更改）\n\`\`\`\n${projectScan.gitStatus}\n\`\`\`\n注意：工作区不干净，请只建议创建 Issue，不要建议直接修改文件。`
    );
  } else {
    contextParts.push(`## 工作区状态\n干净（无未提交更改）`);
  }

  if (recentSuggestions.length > 0) {
    const list = recentSuggestions.map((t) => `- ${t}`).join("\n");
    contextParts.push(`## 过去 30 天已提过的建议（请勿重复，发现新问题）\n${list}`);
  }

  contextParts.push(`## 最近提交记录\n\`\`\`\n${projectScan.gitLog}\n\`\`\``);
  if (projectScan.gitDiff) {
    contextParts.push(`## 最近变更统计\n\`\`\`\n${projectScan.gitDiff}\n\`\`\``);
  }
  for (const [fileName, content] of Object.entries(projectScan.contextFiles)) {
    contextParts.push(`## 文件: ${fileName}\n\`\`\`\n${content}\n\`\`\``);
  }

  const maxTokens = depth === "quick" ? 2048 : 8192;
  const context = contextParts.join("\n\n");

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await callAnthropicJSON(systemPrompt, context, { maxTokens });
    } catch (err) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      // 两次均失败：优雅降级，从错误消息中尝试提取 summary
      const raw = err.message || "";
      const summaryMatch = raw.match(/"summary"\s*:\s*"([^"]+)"/);
      return {
        summary: summaryMatch ? summaryMatch[1] : "AI 分析返回格式异常，已跳过",
        actions: [],
        issues: [],
        skipReason: "AI 返回 JSON 解析失败（已重试两次），本次跳过自动操作",
      };
    }
  }
}

// ─── 执行行动 ────────────────────────────────────────────────────────────────

async function executeActions(projectPath, analysis, dryRun, depth, allowCreateIssues = true) {
  const date = todayString();
  const branchName = `jpclaw/proactive-${date}-${Date.now()}`;
  const results = { actions: [], issues: [], prUrl: null };

  const fileActions = (analysis.actions || []).filter(
    (a) => a.type !== "issue" && a.files && a.files.length > 0
  );
  const hasFileActions = fileActions.length > 0;
  const cwd = projectPath;

  if (dryRun) {
    // 文件操作仅记录，不执行
    for (const action of fileActions) {
      results.actions.push({
        type: action.type, title: action.title, status: "dry_run",
        files: (action.files || []).map((f) => f.path),
      });
    }
    // Issues 是无损操作，即使 dryRun 也真实创建（见下方统一创建逻辑）
  }

  if (!dryRun && hasFileActions) {
    // 创建特性分支
    await sh("git checkout main", { cwd, allowFail: true });
    await sh("git pull --rebase origin main", { cwd, allowFail: true });
    await sh(`git checkout -b ${branchName}`, { cwd });

    for (const action of fileActions) {
      const actionResult = {
        type: action.type, title: action.title, status: "pending", files: [],
      };

      try {
        const safeFiles = [];
        for (const file of action.files || []) {
          // [P0] 安全检查：禁止文件
          if (isForbiddenFile(file.path)) {
            actionResult.files.push({ path: file.path, status: "skipped", reason: "文件在禁止列表中" });
            continue;
          }
          // [P0] 安全检查：路径遍历
          if (!isPathSafe(projectPath, file.path)) {
            actionResult.files.push({ path: file.path, status: "skipped", reason: "路径遍历：超出项目范围" });
            continue;
          }

          const fullPath = path.resolve(projectPath, file.path);
          const dir = path.dirname(fullPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(fullPath, file.content, "utf-8");
          actionResult.files.push({ path: file.path, status: "done" });
          safeFiles.push(file.path);
        }

        // [P0] 使用 safeExec 避免命令注入
        if (safeFiles.length > 0) {
          await safeExec("git", ["add", ...safeFiles], { cwd });

          const commitMsg = `proactive: ${action.title}\n\n${action.description || ""}\n\nCo-Authored-By: JPClaw Proactive Coder <noreply@jpclaw.dev>`;
          await safeExec("git", ["commit", "-m", commitMsg], { cwd, allowFail: true });
          actionResult.status = "committed";
        }
      } catch (err) {
        actionResult.status = "failed";
        actionResult.error = err.message;
      }

      results.actions.push(actionResult);
    }

    // [P0] 推送 + 创建 Draft PR，使用 safeExec
    try {
      await safeExec("git", ["push", "-u", "origin", branchName], { cwd });

      const prBody = buildPRDescription(analysis, results);
      const prTitle = `[Proactive] ${date} AI 代码改进`;
      const prOutput = await safeExec(
        "gh", ["pr", "create", "--draft", "--title", prTitle, "--body", prBody, "--base", "main"],
        { cwd, allowFail: true }
      );

      const urlMatch = prOutput.match(/https:\/\/github\.com\/\S+/);
      results.prUrl = urlMatch ? urlMatch[0] : prOutput;
    } catch (err) {
      results.pushError = err.message;
    }

    await sh("git checkout main", { cwd, allowFail: true });
  }

  // [P0] Issues：deep 模式 + 允许创建时才真实创建，其余记录为观察建议
  for (const issue of analysis.issues || []) {
    if (depth !== "deep" || !allowCreateIssues) {
      results.issues.push({ title: issue.title, status: "observation" });
      continue;
    }
    try {
      const args = ["issue", "create", "--title", issue.title, "--body", issue.body || ""];
      const labels = (issue.labels || []).join(",");
      if (labels) args.push("--label", labels);

      const issueOutput = await safeExec("gh", args, { cwd, allowFail: true });
      const urlMatch = issueOutput.match(/https:\/\/github\.com\/\S+/);
      results.issues.push({
        title: issue.title, status: "created",
        url: urlMatch ? urlMatch[0] : issueOutput,
      });
    } catch (err) {
      results.issues.push({ title: issue.title, status: "failed", error: err.message });
    }
  }

  return results;
}

function buildPRDescription(analysis, results) {
  const lines = [];
  lines.push("## 主动型程序员 - AI 自动改进报告");
  lines.push("");
  lines.push(`**日期**: ${todayString()}`);
  lines.push(`**状态总结**: ${analysis.summary || "无"}`);
  lines.push("");
  lines.push("### 执行的改动");
  lines.push("");
  for (const action of results.actions) {
    const emoji = action.status === "committed" ? "✅" : action.status === "failed" ? "❌" : "⏭️";
    lines.push(`${emoji} **[${action.type}]** ${action.title}`);
    if (action.files) {
      for (const f of action.files) {
        lines.push(`  - \`${f.path || f}\` (${f.status || "planned"})`);
      }
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("*由 JPClaw 主动型程序员自动生成*");
  return lines.join("\n");
}

function buildDiscordReport(date, projectResults, dryRun, weeklyInsight = null) {
  const lines = [];
  const title = weeklyInsight
    ? `📊 **主动程序员·周度深度报告${dryRun ? " [DRY RUN]" : ""}** | ${date}`
    : `🤖 **主动型程序员日报${dryRun ? " [DRY RUN]" : ""}** | ${date}`;
  lines.push(title);
  lines.push("");

  for (const proj of projectResults) {
    lines.push(`📂 **${path.basename(proj.path)}**`);
    if (proj.summary) lines.push(`> ${proj.summary}`);
    if (proj.skipReason && !proj.actions?.length && !proj.issues?.length) {
      lines.push(`⏭️ 跳过: ${proj.skipReason}`, "");
      continue;
    }
    if (proj.skipReason) {
      lines.push(`🔍 **分析模式**（${proj.skipReason}）`);
    }

    if (proj.actions?.length > 0) {
      lines.push("**执行的行动:**");
      for (const a of proj.actions) {
        const emoji = a.status === "committed" || a.status === "done" ? "✅" : a.status === "dry_run" ? "🔍" : a.status === "failed" ? "❌" : "⏳";
        lines.push(`${emoji} [${a.type}] ${a.title}`);
      }
    }
    if (proj.issues?.length > 0) {
      const allObservations = proj.issues.every((i) => i.status === "observation");
      lines.push(allObservations ? "**AI 观察建议:**" : "**创建的 Issue:**");
      for (const i of proj.issues) {
        const emoji = i.status === "created" ? "📋" : i.status === "observation" ? "💡" : i.status === "dry_run" ? "🔍" : "❌";
        lines.push(`${emoji} ${i.title}${i.url ? ` - ${i.url}` : ""}`);
      }
    }
    if (proj.prUrl) lines.push(`\n🔗 **Draft PR**: ${proj.prUrl}`);
    if (proj.error) lines.push(`❌ 错误: ${proj.error}`);
    lines.push("");
  }

  if (weeklyInsight) lines.push(buildWeeklyInsightSection(weeklyInsight));
  lines.push("---", "JPClaw 主动型程序员 · 自动生成");
  return lines.join("\n");
}

// ─── 基准对比 ────────────────────────────────────────────────────────────────

const OPENCLAW_PATH = process.env.BENCHMARK_OPENCLAW_PATH || "/Users/mlamp/Workspace/OpenClaw";
const OPENCLAW_FILES = ["README.md", "ARCHITECTURE.md", "VISION.md", "AGENTS.md", "package.json"];

async function gatherOpenClawContext() {
  const parts = [];
  for (const file of OPENCLAW_FILES) {
    const filePath = path.join(OPENCLAW_PATH, file);
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8").slice(0, 2000);
        parts.push(`### ${file}\n${content}`);
      }
    } catch {}
  }
  // 技能列表
  try {
    const skillsDir = path.join(OPENCLAW_PATH, "skills");
    if (fs.existsSync(skillsDir)) {
      const skills = fs.readdirSync(skillsDir).filter((f) => !f.startsWith("."));
      parts.push(`### 技能列表（${skills.length} 个）\n${skills.join(", ")}`);
    }
  } catch {}
  return parts.length > 0 ? parts.join("\n\n") : "OpenClaw 目录不可访问";
}

async function gatherMarketContext() {
  try {
    const { searchWebWithOptions } = await import("../../dist/tools/web.js");
    const queries = [
      "top AI agent frameworks 2026 LangChain AutoGen CrewAI comparison features",
      "best open source personal AI assistant platforms 2026",
    ];
    const results = [];
    for (const query of queries) {
      try {
        const result = await searchWebWithOptions(query);
        results.push(result.slice(0, 2000));
      } catch {}
    }
    return results.join("\n\n---\n\n") || "市场信息获取失败";
  } catch {
    return "市场信息获取失败";
  }
}

// ─── 周报深度洞察（基准对比 + 架构反思，单次 AI 调用）────────────────────────

/** 收集项目代码结构上下文（目录树、文件统计、关键文件） */
async function gatherArchitectContext(projectPath) {
  const cwd = projectPath;
  const parts = [];

  const dirTree = await sh(
    "find src/ -type d -maxdepth 3 2>/dev/null || find . -type d -maxdepth 2 -not -path '*/node_modules/*' -not -path '*/.git/*'",
    { cwd, allowFail: true }
  );
  if (dirTree) parts.push(`### 目录结构\n${dirTree}`);

  const [srcCount, testCount] = await Promise.allSettled([
    sh("find src/ -name '*.ts' -o -name '*.js' -o -name '*.py' 2>/dev/null | grep -v test | grep -v spec | wc -l", { cwd, allowFail: true }),
    sh("find . -name '*.test.ts' -o -name '*.test.js' -o -name '*.spec.ts' -o -name '*.spec.js' 2>/dev/null | wc -l", { cwd, allowFail: true }),
  ]);
  const src = srcCount.status === "fulfilled" ? srcCount.value.trim() : "?";
  const test = testCount.status === "fulfilled" ? testCount.value.trim() : "?";
  parts.push(`### 文件统计\n源文件数: ${src}  测试文件数: ${test}`);

  const keyFiles = [
    "src/js/gateway/index.ts", "src/js/core/engine.ts",
    "src/js/security/middleware.ts", "src/js/scheduler/runner.ts",
    "train.py", "requirements.txt",
  ];
  for (const rel of keyFiles) {
    const fp = path.join(projectPath, rel);
    try {
      if (fs.existsSync(fp)) {
        const content = fs.readFileSync(fp, "utf-8").split("\n").slice(0, 120).join("\n");
        parts.push(`### ${rel}\n\`\`\`\n${content}\n\`\`\``);
      }
    } catch {}
  }

  return parts.join("\n\n");
}

/**
 * 单次 AI 调用，同时完成「基准对比」+「架构反思」，避免两份报告内容重复。
 * 返回合并 JSON：{ benchmark: {...}, architecture: {...} }
 */
async function analyzeWeeklyInsight(jpcClawContext, openClawContext, marketContext, architectContext) {
  const systemPrompt = `你是兼具产品竞争力视角和系统架构师视角的技术负责人。
请基于下方材料，同时完成两项分析并输出合并 JSON（不含 markdown 标记）：

1. **基准对比**（benchmark）：JPClaw 与竞品、市场框架的差距与建议
2. **架构反思**（architecture）：JPClaw 自身代码质量的客观评分

重要：两部分内容不得重复同一条具体发现。benchmark 聚焦「外部竞争力差距」，architecture 聚焦「内部代码质量」。

输出格式：
{
  "benchmark": {
    "strengths": ["JPClaw 真实优势（不客套）"],
    "topSuggestions": ["最重要的3-5条可执行升级建议"],
    "vsOpenClaw": [
      { "dimension": "对比维度", "gap": "差距描述", "suggestion": "具体建议" }
    ],
    "vsMarket": [
      { "feature": "特性名", "priority": "P0|P1|P2", "suggestion": "具体建议" }
    ]
  },
  "architecture": {
    "overallGrade": "B+",
    "dimensions": {
      "architecture":  { "grade": "A",  "finding": "一句话核心发现（含具体定位）" },
      "codeHealth":    { "grade": "B",  "finding": "..." },
      "testing":       { "grade": "C+", "finding": "..." },
      "documentation": { "grade": "B-", "finding": "..." },
      "security":      { "grade": "A-", "finding": "..." }
    },
    "topFindings": ["发现1（带具体文件/模块定位）", "发现2", "发现3"]
  }
}`;

  const userMessage = [
    `## JPClaw 项目文档与现状\n${jpcClawContext}`,
    `## JPClaw 代码结构与关键文件\n${architectContext}`,
    `## OpenClaw 对比资料\n${openClawContext}`,
    `## 市场主流框架资料\n${marketContext}`,
  ].join("\n\n");

  return callAnthropicJSON(systemPrompt, userMessage, { maxTokens: 5000 });
}

/** 渲染周报深度洞察段落（基准对比 + 架构反思） */
function buildWeeklyInsightSection(insight) {
  if (!insight) return "";
  if (insight.error) {
    return ["", "---", "📊 **周报深度洞察**", "", `❌ 分析失败：${insight.error}`].join("\n");
  }

  const lines = [];
  const { benchmark, architecture } = insight;

  // ── 基准对比 ──
  if (benchmark) {
    lines.push("", "---", "📊 **基准对比分析**", "");
    if (benchmark.strengths?.length) {
      lines.push("**JPClaw 优势：**");
      for (const s of benchmark.strengths) lines.push(`✅ ${s}`);
      lines.push("");
    }
    if (benchmark.topSuggestions?.length) {
      lines.push("**TOP 升级建议：**");
      for (const s of benchmark.topSuggestions) lines.push(`🎯 ${s}`);
      lines.push("");
    }
    if (benchmark.vsOpenClaw?.length) {
      lines.push("**vs OpenClaw：**");
      for (const item of benchmark.vsOpenClaw) {
        lines.push(`• **${item.dimension}**：${item.gap} → ${item.suggestion}`);
      }
      lines.push("");
    }
    if (benchmark.vsMarket?.length) {
      lines.push("**vs 市场框架：**");
      for (const item of benchmark.vsMarket) {
        const badge = item.priority === "P0" ? "🔴" : item.priority === "P1" ? "🟡" : "🟢";
        lines.push(`${badge} [${item.priority}] **${item.feature}**：${item.suggestion}`);
      }
    }
  }

  // ── 架构反思 ──
  if (architecture) {
    const dimensionLabels = {
      architecture:  ["🏛", "架构一致性"],
      codeHealth:    ["💊", "代码健康度"],
      testing:       ["🧪", "测试覆盖策略"],
      documentation: ["📖", "文档完整性"],
      security:      ["🔒", "安全边界"],
    };
    lines.push("", "---", `🏗️ **架构师反思**（综合评级: ${architecture.overallGrade || "?"}）`, "");
    for (const [key, [emoji, label]] of Object.entries(dimensionLabels)) {
      const dim = architecture.dimensions?.[key];
      if (dim) lines.push(`${emoji} ${label} [${dim.grade}]：${dim.finding}`);
    }
    if (architecture.topFindings?.length) {
      lines.push("", "**🔍 核心发现：**");
      for (const f of architecture.topFindings) lines.push(`• ${f}`);
    }
  }

  return lines.join("\n");
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

export async function run(input) {
  try {
    let params = {};
    try { params = typeof input === "string" ? JSON.parse(input) : input || {}; } catch { params = {}; }

    const projects = params.projects || [process.cwd()];
    const channelId = params.channelId || DEFAULT_CHANNEL_ID;
    const telegramChatId = params.telegramChatId || process.env.DEFAULT_TELEGRAM_CHAT_ID;
    const depth = params.depth || DEFAULT_DEPTH;
    const dryRun = params.dryRun ?? false;
    const includeBenchmark = params.includeBenchmark ?? false;
    const date = todayString();
    const projectResults = [];

    for (const projectPath of projects) {
      const projResult = { path: projectPath, actions: [], issues: [], prUrl: null, summary: null, skipReason: null, error: null };

      try {
        const scan = await scanProject(projectPath, depth);
        projResult.scan = scan;
        const effectiveDryRun = dryRun || scan.hasUncommittedChanges;
        if (scan.hasUncommittedChanges && !dryRun) {
          projResult.skipReason = "工作区有未提交的更改，仅执行分析模式";
        }

        const recentSuggestions = loadProjectSuggestions(projectPath);
        const analysis = await analyzeWithAI(scan, depth, recentSuggestions);
        projResult.summary = analysis.summary || null;

        if (analysis.skipReason && (!analysis.actions?.length) && (!analysis.issues?.length)) {
          projResult.skipReason = analysis.skipReason;
          projectResults.push(projResult);
          continue;
        }

        const execResults = await executeActions(projectPath, analysis, effectiveDryRun, depth, !includeBenchmark);
        projResult.actions = execResults.actions;
        projResult.issues = execResults.issues;
        projResult.prUrl = execResults.prUrl || null;

        // 记录本次建议标题，供下次去重
        const allTitles = [
          ...(analysis.actions || []).map((a) => a.title).filter(Boolean),
          ...(analysis.issues || []).map((i) => i.title).filter(Boolean),
        ];
        if (allTitles.length > 0) {
          saveProjectSuggestions(projectPath, allTitles);
        }
      } catch (err) {
        projResult.error = err.message;
      }

      projectResults.push(projResult);
    }

    // 周报深度洞察：数据收集并行，单次 AI 调用出两份分析
    let weeklyInsight = null;
    if (includeBenchmark) {
      try {
        const primaryScan = projectResults[0]?.scan;
        const jpcClawContext = Object.entries(primaryScan?.contextFiles || {})
          .map(([k, v]) => `### ${k}\n${v}`)
          .join("\n\n") || "JPClaw 上下文不可用";

        const [openClawContext, marketContext, architectContext] = await Promise.all([
          gatherOpenClawContext(),
          gatherMarketContext(),
          gatherArchitectContext(projects[0]),
        ]);

        weeklyInsight = await analyzeWeeklyInsight(jpcClawContext, openClawContext, marketContext, architectContext);
      } catch (e) {
        console.error("[proactive-coder] 周报深度洞察失败:", e.message);
        weeklyInsight = { error: e.message };
      }
    }

    const report = buildDiscordReport(date, projectResults, dryRun, weeklyInsight);
    let discordMessageIds = [];
    try { discordMessageIds = await sendToDiscord(channelId, report); }
    catch (e) { discordMessageIds = [`error: ${e.message}`]; }

    // Telegram 推送
    let telegramMessageIds = [];
    if (telegramChatId) {
      try { telegramMessageIds = await sendToTelegram(telegramChatId, report); }
      catch (e) { telegramMessageIds = [`error: ${e.message}`]; }
    }

    return JSON.stringify({
      ok: true, date, dryRun,
      projects: projectResults.map((p) => ({
        path: p.path, summary: p.summary, skipReason: p.skipReason,
        actions: p.actions, issues: p.issues, prUrl: p.prUrl, error: p.error,
      })),
      weeklyInsight: weeklyInsight || undefined,
      discordMessageIds, telegramMessageIds,
      message: dryRun
        ? "主动型程序员分析报告（DRY RUN）已推送到 Discord"
        : `主动型程序员报告已推送到 Discord 频道 ${channelId}`,
    }, null, 2);
  } catch (error) {
    return JSON.stringify({ ok: false, error: error.message }, null, 2);
  }
}

export default run;
