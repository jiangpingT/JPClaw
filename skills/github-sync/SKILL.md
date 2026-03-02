---
name: github-sync
description: GitHub 代码同步 - 每日自动将关注的 GitHub 开源项目同步到本地。支持多项目配置，自动判断首次 Clone 还是增量 Pull，记录新增提交并推送摘要到 Discord/Telegram。适用于"同步开源代码"、"追踪上游更新"等场景。由 scheduler 每日 23:00 触发，也可手动调用。
metadata:
  {
    "openclaw":
      {
        "emoji": "🔄",
        "requires": { "env": ["DISCORD_BOT1_TOKEN"] },
      },
  }
---

# GitHub 代码同步 (GitHub Sync)

每日自动追踪关注的 GitHub 开源项目，将最新代码同步到本地，并播报新增提交摘要。

## 执行流程

1. **遍历项目列表**：读取 payload 中的 repos 配置（或默认列表）
2. **判断同步方式**：本地无仓库则 `git clone`，已存在则 `git fetch + reset --hard`
3. **记录新增提交**：对比 pull 前后的 HEAD，提取新增 commit 列表
4. **推送通知**：汇总结果发送到 Discord 和 Telegram

## 输入参数

```json
{
  "repos": [
    {
      "name": "OpenClaw",
      "repo": "https://github.com/openclaw/openclaw",
      "localPath": "/Users/mlamp/Workspace/OpenClaw",
      "branch": "main"
    }
  ],
  "channelId": "1469204772379693222",
  "telegramChatId": "-1003855994917"
}
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| repos | object[] | 见默认列表 | 要同步的项目列表 |
| repos[].name | string | - | 项目显示名称 |
| repos[].repo | string | - | GitHub 仓库 URL |
| repos[].localPath | string | - | 本地同步目录 |
| repos[].branch | string | "main" | 目标分支（可不填，自动检测） |
| channelId | string | DEFAULT_DISCORD_CHANNEL_ID | Discord 通知频道 ID |
| telegramChatId | string | DEFAULT_TELEGRAM_CHAT_ID | Telegram Chat ID |

## 输出格式

```json
{
  "ok": true,
  "date": "2026-02-25",
  "results": [
    {
      "name": "OpenClaw",
      "ok": true,
      "action": "pull",
      "newCommits": 3,
      "commits": ["a1b2c3d feat: xxx", "..."]
    }
  ],
  "discordMessageIds": ["123456"],
  "telegramMessageIds": ["789"],
  "message": "GitHub 代码同步完成"
}
```

## 通知样例

```
🔄 GitHub 代码同步报告 | 2026-02-25

**OpenClaw** ✅ Pull 更新 · 3 个新提交
  • `a1b2c3d feat: add new skill api`
  • `b2c3d4e fix: memory leak in agent loop`
  • `c3d4e5f docs: update README`

---
JPClaw GitHub 同步 · 自动生成 · 全部成功
```

## 扩展：添加更多项目

在 tasks.json 的 payload.repos 数组中追加新项目即可，无需修改 skill 代码：

```json
{
  "name": "新项目名",
  "repo": "https://github.com/xxx/yyy",
  "localPath": "/Users/mlamp/Workspace/YYY"
}
```

## 环境变量

- `DISCORD_BOT1_TOKEN` / `DISCORD_TOKEN` - Discord Bot Token
- `DISCORD_PROXY_URL` - 代理设置
- `DEFAULT_DISCORD_CHANNEL_ID` - 默认 Discord 频道
- `DEFAULT_TELEGRAM_CHAT_ID` - 默认 Telegram Chat ID
