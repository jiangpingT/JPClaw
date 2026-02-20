---
name: afternoon-report
description: 下午研究报告 - 每日基于兴趣主题进行深度研究。从 HackerNews、GitHub Trending、技术博客等数据源收集最新动态，由 AI 组织成结构化研究报告并推送到 Discord。持续积累专业洞察，而非临时搜索。适用于"研究报告"、"技术调研"、"趋势分析"等场景。可由 scheduler 每日下午触发，也可手动调用。
metadata:
  {
    "openclaw":
      {
        "emoji": "📚",
        "requires": { "env": ["ANTHROPIC_AUTH_TOKEN", "DISCORD_BOT1_TOKEN"] },
      },
  }
---

# Afternoon Report (下午研究报告)

每日基于用户兴趣主题进行深度研究，从多个公开数据源收集最新动态，生成结构化研究报告。

## 执行流程

1. **确定主题**: 根据配置的兴趣主题列表
2. **多源采集**: 从 HackerNews、GitHub Trending、Google News 等采集数据
3. **AI 分析**: 由 AI 整合分析，生成结构化报告
4. **持久化**: 保存完整报告到 sessions/brain/reports/
5. **Discord 推送**: 将摘要推送到指定频道

## 输入参数

```json
{
  "topics": ["AI", "LLM", "TypeScript", "创业"],
  "depth": "standard",
  "lookbackDays": 7,
  "channelId": "1469204772379693222"
}
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| topics | string[] | ["AI","LLM","TypeScript","创业"] | 研究主题 |
| depth | string | "standard" | 深度：quick / standard / deep |
| lookbackDays | number | 7 | 搜索时间窗口（天） |
| channelId | string | "1469204772379693222" | Discord 通知频道 ID |

## 环境变量

- `ANTHROPIC_BASE_URL` - AI API 代理地址
- `ANTHROPIC_AUTH_TOKEN` - AI API Token
- `DISCORD_BOT1_TOKEN` / `DISCORD_TOKEN` - Discord Bot Token
- `DISCORD_PROXY_URL` - 代理设置
