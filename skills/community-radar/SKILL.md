---
name: community-radar
description: 社区雷达 - 扫描 Reddit、HackerNews 近 30 天社区讨论，获取工具和话题的真实用户反馈。通过情感分析和趋势识别，发现社区热点、常见痛点和新兴项目。推送分析报告到 Discord。适用于"社区反馈"、"用户声音"、"舆情分析"等场景。可由 scheduler 每日触发，也可手动调用。
metadata:
  {
    "openclaw":
      {
        "emoji": "📡",
        "requires": { "env": ["ANTHROPIC_AUTH_TOKEN", "DISCORD_BOT1_TOKEN"] },
      },
  }
---

# Community Radar (社区雷达)

扫描 Reddit、HackerNews 近 30 天社区讨论，获取真实用户反馈，而非官方营销信息。

## 执行流程

1. **话题锁定**: 根据配置的关键词列表
2. **信息收集**: 从 Reddit RSS、HackerNews API 获取近 30 天讨论
3. **AI 分析**: 情感分析、趋势识别、热点提取
4. **报告生成**: 热点排名 + 情感分布 + 精选讨论
5. **Discord 推送**: 摘要推送到指定频道

## 输入参数

```json
{
  "keywords": ["LLM", "Claude", "AI", "TypeScript"],
  "sources": ["reddit", "hackernews"],
  "lookbackDays": 30,
  "minEngagement": 10,
  "channelId": "1469204772379693222"
}
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| keywords | string[] | ["LLM","Claude","AI","TypeScript"] | 搜索关键词 |
| sources | string[] | ["reddit","hackernews"] | 数据源 |
| lookbackDays | number | 30 | 回溯天数 |
| minEngagement | number | 10 | 最小互动数（评论/点赞） |
| channelId | string | "1469204772379693222" | Discord 通知频道 ID |

## 环境变量

- `ANTHROPIC_BASE_URL` - AI API 代理地址
- `ANTHROPIC_AUTH_TOKEN` - AI API Token
- `DISCORD_BOT1_TOKEN` / `DISCORD_TOKEN` - Discord Bot Token
- `DISCORD_PROXY_URL` - 代理设置
