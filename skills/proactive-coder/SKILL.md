---
name: proactive-coder
description: 主动型程序员 - AI 驱动的代码改进与项目维护工具。扫描指定项目的 git 状态、代码质量和文档完整性，由 AI 自主判断可改进项目并执行。在安全边界内创建特性分支、提交改动、创建 Draft PR，并推送执行摘要到 Discord。适用于"检查项目状态"、"自动改进代码"、"夜间值班"等场景。可由 scheduler 每日凌晨触发，也可手动调用。
metadata:
  {
    "openclaw":
      {
        "emoji": "🤖",
        "requires": { "env": ["ANTHROPIC_AUTH_TOKEN", "DISCORD_BOT1_TOKEN"] },
      },
  }
---

# Proactive Coder (主动型程序员)

AI 驱动的项目夜间值班程序员。自主扫描项目状态，判断可改进项，在安全边界内执行改动并创建 Draft PR。

## 执行流程

1. **扫描项目**: git status、git log、关键文件（CLAUDE.md, ARCHITECTURE.md, package.json）
2. **AI 分析决策**: 将项目完整状态交给 AI，由 AI 自主判断可做的改进
3. **执行改动**: 创建特性分支，执行改动，提交并推送
4. **创建 Draft PR**: 通过 gh CLI 创建 Draft PR
5. **Discord 通知**: 推送执行摘要到指定频道

## 安全边界

允许：创建特性分支 (jpclaw/proactive-*)、提交代码、推送特性分支、创建 Draft PR、创建 Issue
禁止：推送 main/master、合并 PR、删除分支、Force push、修改 CI/CD 配置、修改 .env 或凭证文件

## 输入参数

```json
{
  "projects": ["/Users/mlamp/Workspace/JPClaw"],
  "channelId": "1469204772379693222",
  "depth": "standard",
  "dryRun": false
}
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| projects | string[] | [当前项目] | 要分析的项目路径列表 |
| channelId | string | "1469204772379693222" | Discord 通知频道 ID |
| depth | string | "standard" | 分析深度：quick / standard / deep |
| dryRun | boolean | false | 仅分析不执行（不创建分支/PR） |

## 输出格式

```json
{
  "ok": true,
  "date": "2026-02-19",
  "projects": [
    {
      "path": "/Users/mlamp/Workspace/JPClaw",
      "actions": [
        { "type": "pr", "title": "...", "url": "..." },
        { "type": "issue", "title": "...", "url": "..." }
      ],
      "summary": "..."
    }
  ],
  "discordMessageIds": ["123456"],
  "message": "主动型程序员报告已推送到 Discord"
}
```

## 环境变量

- `ANTHROPIC_BASE_URL` - AI API 代理地址
- `ANTHROPIC_AUTH_TOKEN` - AI API Token
- `DISCORD_BOT1_TOKEN` / `DISCORD_TOKEN` - Discord Bot Token
- `DISCORD_PROXY_URL` - 代理设置
