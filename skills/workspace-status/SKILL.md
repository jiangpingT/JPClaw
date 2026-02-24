---
name: workspace-status
description: 工作台状态查询 - 查看项目当前改动、最近提交、开放 PR。适用于「当前状态」「工作台」「最近改了什么」「有什么PR」「工作区干净吗」「今天改了哪些」「代码库情况」「项目进度」等查询。
---

# Workspace Status Skill

聚合多个项目的 git 状态快照，专为手机小屏优化，推送到 Discord + Telegram。

## Input

```json
{
  "projects": ["（可选）项目路径数组，默认 JPClaw + JPRobot"],
  "channelId": "（可选）Discord 频道 ID",
  "telegramChatId": "（可选）Telegram Chat ID",
  "sendToChannel": true
}
```

空 input 也可以，直接用默认配置扫描。

## Output

```json
{
  "ok": true,
  "report": "📊 工作台状态 | 2026-02-24 11:00\n\n📁 JPClaw\n  ⚠️ 未提交：3 个文件\n  ...",
  "notifications": ["discord_message_ids", "telegram_message_ids"]
}
```

## 报告示例

```
📊 工作台状态 | 2026-02-24 11:00

📁 JPClaw
  ⚠️ 未提交：3 个文件
    · M skills/notify/index.js
    · M skills/workspace-status/index.js
    · ?? crash.log
  📝 最近提交：
    • abc1234 feat: proactive-pm skill (2h ago)
    • def5678 fix: morning brief date bug (3h ago)
  🔀 PR #12 feat/remote-coder [open]

📁 JPRobot
  ✅ 工作区干净
  📝 最近提交：
    • xyz9999 fix: gait controller (1d ago)
  🔀 暂无开放 PR
```

## 数据来源

- `git status --short` → 未提交文件列表
- `git log --oneline -5` → 最近提交
- `gh pr list --limit 3` → 最近 PR（失败时降级跳过）

## 依赖

- `DISCORD_BOT1_TOKEN`：Discord Bot Token
- `gh` CLI（PR 查询，可选）
