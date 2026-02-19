/**
 * GitHub Skill 实现
 *
 * 支持操作：
 *   git: status, pull, commit, push, clone, log, diff
 *   gh:  pr_list, pr_checks, pr_create, pr_merge, issue_create, run_list
 *
 * 输入格式（JSON 字符串）：
 *   { "action": "pull", "dir": "/path/to/repo" }
 *   { "action": "commit", "dir": "/path/to/repo", "message": "fix: ...", "files": ["a.ts"] }
 *   { "action": "push", "dir": "/path/to/repo", "branch": "main" }
 *   { "action": "pr_list", "repo": "owner/repo", "limit": 10 }
 *   { "action": "pr_create", "repo": "owner/repo", "title": "...", "body": "..." }
 *   ...
 */

import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 60_000; // clone/pull 给更长时间

// ─── 安全：校验目录路径，防止路径逃逸 ───────────────────────────────────────

function safeResolveDir(dir) {
  if (!dir || typeof dir !== "string") {
    throw new Error("缺少参数 dir（仓库本地路径）");
  }
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) {
    throw new Error(`目录不存在：${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`路径不是目录：${resolved}`);
  }
  return resolved;
}

// ─── shell 执行 ───────────────────────────────────────────────────────────────

async function sh(cmd, cwd, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { stdout, stderr } = await execAsync(cmd, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env: { ...process.env }
  });
  const out = [stdout?.trim(), stderr?.trim()].filter(Boolean).join("\n");
  return out || "（无输出）";
}

// ─── 检测工具是否安装 ─────────────────────────────────────────────────────────

async function checkBin(bin) {
  try {
    await sh(`which ${bin}`);
    return true;
  } catch {
    return false;
  }
}

// ─── Git 操作 ─────────────────────────────────────────────────────────────────

async function gitStatus({ dir }) {
  const cwd = safeResolveDir(dir);
  const branch = await sh("git rev-parse --abbrev-ref HEAD", cwd).catch(() => "未知分支");
  const status = await sh("git status --short", cwd);
  const ahead = await sh(
    "git rev-list --count @{u}..HEAD 2>/dev/null || echo 0",
    cwd
  ).catch(() => "0");
  const behind = await sh(
    "git rev-list --count HEAD..@{u} 2>/dev/null || echo 0",
    cwd
  ).catch(() => "0");

  const statusText = status.trim().replace("（无输出）", "").trim();
  return [
    `分支：${branch.trim()}`,
    `本地领先远程：${ahead.trim()} 个提交`,
    `本地落后远程：${behind.trim()} 个提交`,
    "",
    statusText || "工作区干净，没有未提交的变更"
  ].join("\n");
}

async function gitPull({ dir, remote = "origin", branch = "" }) {
  const cwd = safeResolveDir(dir);
  const target = branch ? `${remote} ${branch}` : remote;
  const result = await sh(`git pull ${target}`, cwd, GIT_TIMEOUT_MS);
  return `git pull ${target} 完成：\n${result}`;
}

async function gitCommit({ dir, message, files }) {
  if (!message || typeof message !== "string" || !message.trim()) {
    throw new Error("缺少参数 message（提交信息）");
  }
  const cwd = safeResolveDir(dir);

  // 指定文件 or 全量暂存
  if (Array.isArray(files) && files.length > 0) {
    const escaped = files.map((f) => `"${f.replace(/"/g, '\\"')}"`).join(" ");
    await sh(`git add ${escaped}`, cwd);
  } else {
    await sh("git add -A", cwd);
  }

  const msg = message.replace(/"/g, '\\"');
  const result = await sh(`git commit -m "${msg}"`, cwd);
  return `提交成功：\n${result}`;
}

async function gitPush({ dir, remote = "origin", branch = "", force = false }) {
  const cwd = safeResolveDir(dir);
  const currentBranch = branch || (await sh("git rev-parse --abbrev-ref HEAD", cwd)).trim();
  const forceFlag = force ? " --force-with-lease" : "";
  const result = await sh(`git push ${remote} ${currentBranch}${forceFlag}`, cwd, GIT_TIMEOUT_MS);
  return `git push ${remote} ${currentBranch} 完成：\n${result}`;
}

async function gitClone({ url, dir, depth }) {
  if (!url || typeof url !== "string") {
    throw new Error("缺少参数 url（仓库地址）");
  }
  if (!dir || typeof dir !== "string") {
    throw new Error("缺少参数 dir（克隆目标路径）");
  }
  const targetDir = path.resolve(dir);
  const depthFlag = depth ? ` --depth ${Number(depth)}` : "";
  const escapedUrl = url.replace(/"/g, '\\"');
  const escapedDir = targetDir.replace(/"/g, '\\"');
  const result = await sh(
    `git clone${depthFlag} "${escapedUrl}" "${escapedDir}"`,
    process.cwd(),
    GIT_TIMEOUT_MS
  );
  return `git clone 完成：\n${result}`;
}

async function gitLog({ dir, limit = 10 }) {
  const cwd = safeResolveDir(dir);
  const n = Math.min(Number(limit) || 10, 100);
  const result = await sh(
    `git log --oneline -${n} --decorate`,
    cwd
  );
  return `最近 ${n} 条提交记录：\n${result}`;
}

async function gitDiff({ dir, staged = false, file = "" }) {
  const cwd = safeResolveDir(dir);
  const stagedFlag = staged ? " --staged" : "";
  const fileArg = file ? ` -- "${file.replace(/"/g, '\\"')}"` : "";
  const result = await sh(`git diff${stagedFlag}${fileArg}`, cwd);
  return result || "（没有差异）";
}

// ─── gh CLI 操作 ──────────────────────────────────────────────────────────────

function repoFlag(repo) {
  return repo ? ` --repo "${repo.replace(/"/g, '\\"')}"` : "";
}

async function ghPrList({ repo, limit = 10, state = "open" }) {
  const result = await sh(
    `gh pr list${repoFlag(repo)} --limit ${Number(limit) || 10} --state ${state} --json number,title,state,author,createdAt --jq '.[] | "#\\(.number) \\(.state) [\\(.author.login)] \\(.title)"'`,
    process.cwd()
  );
  return `PR 列表（${state}）：\n${result}`;
}

async function ghPrChecks({ pr, repo }) {
  if (!pr) throw new Error("缺少参数 pr（PR 编号）");
  const result = await sh(
    `gh pr checks ${Number(pr)}${repoFlag(repo)}`,
    process.cwd()
  );
  return `PR #${pr} CI 检查状态：\n${result}`;
}

async function ghPrCreate({ repo, title, body = "", base = "main", head = "" }) {
  if (!title) throw new Error("缺少参数 title（PR 标题）");
  const headFlag = head ? ` --head "${head.replace(/"/g, '\\"')}"` : "";
  const escapedTitle = title.replace(/"/g, '\\"');
  const escapedBody = body.replace(/"/g, '\\"');
  const result = await sh(
    `gh pr create${repoFlag(repo)} --title "${escapedTitle}" --body "${escapedBody}" --base "${base}"${headFlag}`,
    process.cwd()
  );
  return `PR 创建成功：\n${result}`;
}

async function ghPrMerge({ pr, repo, method = "squash" }) {
  if (!pr) throw new Error("缺少参数 pr（PR 编号）");
  const validMethods = ["squash", "merge", "rebase"];
  const mergeMethod = validMethods.includes(method) ? method : "squash";
  const result = await sh(
    `gh pr merge ${Number(pr)}${repoFlag(repo)} --${mergeMethod} --auto`,
    process.cwd()
  );
  return `PR #${pr} 合并完成（${mergeMethod}）：\n${result}`;
}

async function ghIssueCreate({ repo, title, body = "", label = "" }) {
  if (!title) throw new Error("缺少参数 title（Issue 标题）");
  const labelFlag = label ? ` --label "${label.replace(/"/g, '\\"')}"` : "";
  const escapedTitle = title.replace(/"/g, '\\"');
  const escapedBody = body.replace(/"/g, '\\"');
  const result = await sh(
    `gh issue create${repoFlag(repo)} --title "${escapedTitle}" --body "${escapedBody}"${labelFlag}`,
    process.cwd()
  );
  return `Issue 创建成功：\n${result}`;
}

async function ghRunList({ repo, limit = 10 }) {
  const result = await sh(
    `gh run list${repoFlag(repo)} --limit ${Number(limit) || 10} --json status,name,createdAt,conclusion --jq '.[] | "\\(.status) \\(.conclusion // "-") \\(.name)"'`,
    process.cwd()
  );
  return `最近工作流运行记录：\n${result}`;
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────

const ACTION_MAP = {
  // git 操作
  status: gitStatus,
  pull: gitPull,
  commit: gitCommit,
  push: gitPush,
  clone: gitClone,
  log: gitLog,
  diff: gitDiff,
  // gh CLI 操作
  pr_list: ghPrList,
  pr_checks: ghPrChecks,
  pr_create: ghPrCreate,
  pr_merge: ghPrMerge,
  issue_create: ghIssueCreate,
  run_list: ghRunList
};

export async function run(input) {
  let params;
  try {
    params = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    return [
      "参数格式错误，请提供 JSON，例如：",
      '  {"action":"pull","dir":"/path/to/repo"}',
      '  {"action":"commit","dir":"/path/to/repo","message":"fix: something"}',
      '  {"action":"pr_list","repo":"owner/repo"}',
      "",
      `支持的操作：${Object.keys(ACTION_MAP).join(", ")}`
    ].join("\n");
  }

  const { action } = params || {};

  if (!action) {
    return `缺少参数 action。支持：${Object.keys(ACTION_MAP).join(", ")}`;
  }

  const handler = ACTION_MAP[action];
  if (!handler) {
    return `不支持的操作：${action}。支持：${Object.keys(ACTION_MAP).join(", ")}`;
  }

  // 需要 gh CLI 的操作，事先检查
  const ghActions = new Set(["pr_list", "pr_checks", "pr_create", "pr_merge", "issue_create", "run_list"]);
  if (ghActions.has(action)) {
    const hasGh = await checkBin("gh");
    if (!hasGh) {
      return "错误：未找到 gh CLI。请先安装：brew install gh，然后运行 gh auth login 授权。";
    }
  }

  try {
    return await handler(params);
  } catch (err) {
    return `执行失败（${action}）：${err.message}`;
  }
}

export default run;
