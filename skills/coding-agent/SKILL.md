---
name: coding-agent
description: 代码助手集成工具。**默认使用 Claude Code（`claude` 命令）**，除非用户明确指定其他工具（Codex、OpenCode、Pi）。支持一次性任务执行、后台运行、进程监控、输入提交、PR审查、并行修复、工作树管理等。适用于"帮我写代码"、"修复这个bug"、"代码审查"、"修复Issue"、"自动编程"等查询。必须使用 PTY 模式，需要在 git 仓库中运行。
metadata:
  {
    "openclaw": { "emoji": "🧩", "requires": { "anyBins": ["claude", "codex", "opencode", "pi"] } },
  }
---

# Coding Agent（bash 优先）

所有编程 agent 任务统一通过 **bash**（可选后台模式）执行，简单直接。

## ⚠️ PTY 模式必须开启

编程 agent（Claude Code、Codex、Pi）都是**交互式终端程序**，必须在伪终端（PTY）中运行。没有 PTY 会导致输出乱码、颜色丢失或 agent 卡死。

**运行编程 agent 时始终加 `pty:true`**：

```bash
# ✅ 正确 - 带 PTY
bash pty:true command:"claude 'Your prompt'"

# ❌ 错误 - 无 PTY，agent 可能卡死
bash command:"claude 'Your prompt'"
```

### bash 工具参数说明

| 参数         | 类型    | 说明                                         |
| ------------ | ------- | -------------------------------------------- |
| `command`    | string  | 要执行的 shell 命令                          |
| `pty`        | boolean | **编程 agent 必须开启**，分配伪终端          |
| `workdir`    | string  | 工作目录（agent 只会看到该目录的上下文）     |
| `background` | boolean | 后台运行，返回 sessionId 供后续监控          |
| `timeout`    | number  | 超时秒数（超时后自动 kill 进程）             |
| `elevated`   | boolean | 在宿主机上运行而非沙箱（需权限允许）         |

### process 工具操作（用于后台会话）

| 操作        | 说明                                     |
| ----------- | ---------------------------------------- |
| `list`      | 列出所有运行中或近期的会话               |
| `poll`      | 检查会话是否仍在运行                     |
| `log`       | 获取会话输出（支持 offset/limit）        |
| `write`     | 向 stdin 发送原始数据                    |
| `submit`    | 发送数据 + 换行（相当于输入后按 Enter）  |
| `send-keys` | 发送按键序列或十六进制字节               |
| `paste`     | 粘贴文本（支持括号模式）                 |
| `kill`      | 终止会话                                 |

---

## 快速开始：一次性任务

**默认使用 Claude Code**，仅当用户明确要求时才切换到 Codex：

```bash
# 默认：Claude Code（推荐）
bash pty:true workdir:~/project command:"claude '给 API 调用加上错误处理'"

# 临时目录（Claude Code 不强制要求 git，但建议在项目目录运行）
bash pty:true workdir:$(mktemp -d) command:"claude '你的任务描述'"

# 用户明确要求 Codex 时才切换（Codex 需要 git repo！）
SCRATCH=$(mktemp -d) && git init $SCRATCH && bash pty:true workdir:$SCRATCH command:"codex exec '你的任务描述'"
```

---

## 标准模式：workdir + background + pty

较长的任务使用后台模式 + PTY：

```bash
# 后台启动 Claude Code
bash pty:true workdir:~/project background:true command:"claude '开发一个贪吃蛇游戏'"
# 返回 sessionId 供后续追踪

# 查看进度
process action:log sessionId:XXX

# 检查是否完成
process action:poll sessionId:XXX

# 发送输入（agent 提问时）
process action:write sessionId:XXX data:"y"

# 发送输入 + 回车（相当于输入 "yes" 并按 Enter）
process action:submit sessionId:XXX data:"yes"

# 必要时终止
process action:kill sessionId:XXX
```

**为什么 workdir 很重要**：agent 在指定目录中启动，不会到处读无关文件。

---

## Claude Code（默认工具）

```bash
# 一次性任务（带 PTY）
bash pty:true workdir:~/project command:"claude '你的任务'"

# 后台长任务
bash pty:true workdir:~/project background:true command:"claude '你的任务'"
```

---

## Codex CLI（用户明确要求时使用）

**默认模型**：`gpt-5.2-codex`（在 `~/.codex/config.toml` 中配置）

### 常用参数

| 参数            | 效果                                         |
| --------------- | -------------------------------------------- |
| `exec "prompt"` | 一次性执行，完成后退出                       |
| `--full-auto`   | 沙箱模式，在工作区内自动确认所有操作         |
| `--yolo`        | 无沙箱、无确认（最快，风险最高）             |

### 构建/开发

```bash
# 一次性执行（自动确认）
bash pty:true workdir:~/project command:"codex exec --full-auto '构建一个深色模式切换'"

# 后台长任务
bash pty:true workdir:~/project background:true command:"codex --yolo '重构认证模块'"
```

### PR Code Review

**⚠️ 重要：永远不要在 OpenClaw 项目目录里做 PR Review！**
请 clone 到临时目录或使用 git worktree。

```bash
# clone 到临时目录（安全）
REVIEW_DIR=$(mktemp -d)
git clone https://github.com/user/repo.git $REVIEW_DIR
cd $REVIEW_DIR && gh pr checkout 130
bash pty:true workdir:$REVIEW_DIR command:"claude 'review PR #130，对比 origin/main'"
# 完成后清理：trash $REVIEW_DIR

# 或使用 git worktree（保持主目录干净）
git worktree add /tmp/pr-130-review pr-130-branch
bash pty:true workdir:/tmp/pr-130-review command:"claude 'review 这个分支的改动，对比 main'"
```

### 批量 PR Review（并行）

```bash
# 先拉取所有 PR 引用
git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'

# 并行启动多个 agent，每个负责一个 PR
bash pty:true workdir:~/project background:true command:"claude 'Review PR #86。git diff origin/main...origin/pr/86'"
bash pty:true workdir:~/project background:true command:"claude 'Review PR #87。git diff origin/main...origin/pr/87'"

# 监控所有任务
process action:list

# 发布结果到 GitHub
gh pr comment <PR号> --body "<review 内容>"
```

---

## OpenCode（用户指定时使用）

```bash
bash pty:true workdir:~/project command:"opencode run '你的任务'"
```

---

## Pi Coding Agent（用户指定时使用）

```bash
# 安装：npm install -g @mariozechner/pi-coding-agent
bash pty:true workdir:~/project command:"pi '你的任务'"

# 非交互模式（仍建议开 PTY）
bash pty:true command:"pi -p '总结 src/ 目录'"

# 指定 provider 和模型
bash pty:true command:"pi --provider openai --model gpt-4o-mini -p '你的任务'"
```

---

## 并行修复多个 Issue（git worktree）

```bash
# 1. 为每个 Issue 创建独立 worktree
git worktree add -b fix/issue-78 /tmp/issue-78 main
git worktree add -b fix/issue-99 /tmp/issue-99 main

# 2. 在各 worktree 中并行启动 Claude Code
bash pty:true workdir:/tmp/issue-78 background:true command:"pnpm install && claude '修复 Issue #78：<问题描述>。完成后 commit 并 push。'"
bash pty:true workdir:/tmp/issue-99 background:true command:"pnpm install && claude '修复 Issue #99：<问题描述>。完成后 commit 并 push。'"

# 3. 监控进度
process action:list
process action:log sessionId:XXX

# 4. 修复完成后创建 PR
cd /tmp/issue-78 && git push -u origin fix/issue-78
gh pr create --repo user/repo --head fix/issue-78 --title "fix: ..." --body "..."

# 5. 清理 worktree
git worktree remove /tmp/issue-78
git worktree remove /tmp/issue-99
```

---

## ⚠️ 使用规则

1. **始终加 pty:true** — 编程 agent 是交互式终端程序，没有 PTY 会卡死或输出乱码
2. **默认用 Claude Code** — 使用 `claude` 命令，除非用户明确指定 Codex 或其他工具
   - 编排模式：不要自己手写代码补丁，让 agent 来做
   - agent 挂掉或卡死时，重新拉起或询问用户方向，不要悄悄自己接管
3. **要有耐心** — 不要因为"太慢"就 kill 会话
4. **用 process:log 监控** — 只看进度，不要干预执行
5. **允许并行** — 可以同时跑多个 Claude Code 进程处理批量任务
6. **禁止在 ~/clawd/ 里启动 agent** — 会读到私人文档，产生奇怪行为
7. **workdir 必须是用户指定的项目路径** — 默认项目在 `/Users/mlamp/Workspace/JPClaw` 或 `/Users/mlamp/Workspace/JPRobot`，禁止自行猜测或使用其他路径

---

## 进度汇报（重要）

后台启动 agent 时，要让用户知道发生了什么：

- 启动时发一条简短消息（在跑什么 + 在哪个目录）
- 之后只在以下情况再汇报：
  - 阶段性完成（构建成功、测试通过）
  - agent 提问或需要用户输入
  - 遇到错误或需要用户决策
  - 任务结束（说明改了什么 + 在哪里）
- kill 会话时立刻说明原因

这样用户不会只看到一句「Agent failed」而完全不知道发生了什么。

---

## 任务完成后自动通知

长时间后台任务结束后，在 prompt 里加一条 curl 命令，任务完成即可秒级推送到 Discord + Telegram：

```bash
# 通知命令（Discord + Telegram）
curl -s -X POST http://localhost:18790/skills/run \
  -H "Content-Type: application/json" \
  -d '{"name":"notify","input":"{\"message\":\"✅ 完成：[简要描述]\"}"}'
```

**完整后台任务模板：**

```bash
bash pty:true workdir:~/project background:true command:"claude '你的任务描述。

完成后运行以下命令通知我：
curl -s -X POST http://localhost:18790/skills/run -H \"Content-Type: application/json\" -d \"{\\\"name\\\":\\\"notify\\\",\\\"input\\\":\\\"{\\\\\\\"message\\\\\\\":\\\\\\\"✅ 完成：[摘要]\\\\\\\"}\\\"}\""
```

这会调用本地 notify skill，同时推送到 Discord 和 Telegram，秒级到达，不用手动轮询。

---

## 经验总结

- **PTY 是必须的**：编程 agent 是交互式终端程序，没有 `pty:true` 输出会乱或直接卡死
- **Claude Code 不强制要求 git repo**：可直接在任意目录运行，比 Codex 更灵活
- **Codex 需要 git repo**：在非 git 目录运行 Codex 会报错，用 `mktemp -d && git init` 临时解决
- **submit vs write**：`submit` = 发送内容 + 回车（相当于敲 Enter），`write` = 只发原始数据不带换行
