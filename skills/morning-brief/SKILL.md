---
name: morning-brief
description: 晨间简报生成与推送工具。从多个数据源（天气、新闻、待办任务）收集信息，调用 AI 组装结构化的晨间简报，并推送到 Discord 指定频道。支持自定义城市、新闻主题、目标频道。适用于"生成晨间简报"、"发送早间摘要"、"今日简报"等查询。可由 scheduler 定时触发，也可手动调用。
metadata:
  {
    "openclaw":
      {
        "emoji": "📰",
        "requires": { "env": ["ANTHROPIC_AUTH_TOKEN", "DISCORD_BOT1_TOKEN"] },
      },
  }
---

# Morning Brief (晨间简报)

每日自动收集天气、新闻、待办任务等信息，通过 AI 组装成结构化简报并推送到 Discord 频道。

## 执行流程

1. **并行获取数据**: 天气 (wttr.in)、新闻 (Google/Bing RSS)、待办任务 (tasks.json)
2. **AI 组装简报**: 调用 Anthropic API 将原始数据组装成中文简报
3. **推送到 Discord**: 通过 Discord REST API 发送到指定频道
4. **返回执行结果**: JSON 格式的执行状态

## 输入参数

```json
{
  "city": "北京",
  "channelId": "1469204772379693222",
  "newsTopics": ["AI", "科技", "创业"]
}
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| city | string | "北京" | 天气查询城市 |
| channelId | string | "1469204772379693222" | Discord 目标频道 ID |
| newsTopics | string[] | ["AI", "科技", "创业"] | 新闻查询主题 |

## 输出格式

```json
{
  "ok": true,
  "briefDate": "2026-02-19",
  "sections": {
    "weather": true,
    "news": true,
    "tasks": true
  },
  "discordMessageIds": ["123456"],
  "message": "晨间简报已推送到 Discord"
}
```

## 环境变量

- `ANTHROPIC_BASE_URL` - AI API 代理地址 (已有)
- `ANTHROPIC_AUTH_TOKEN` - AI API Token (已有)
- `DISCORD_BOT1_TOKEN` / `DISCORD_TOKEN` - Discord Bot Token (已有)
- `DISCORD_PROXY_URL` - 代理设置 (已有)
