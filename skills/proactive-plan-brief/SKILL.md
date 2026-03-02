---
name: proactive-plan-brief
description: Plan计划日报 - 每日早晨读取 macOS「Plan计划」备忘录中昨日的计划条目，由 AI 解读后推送到 Discord/Telegram。适用于"昨天计划播报"、"Plan备忘录日报"等场景。每日 08:45 自动触发。
metadata:
  {
    "openclaw":
      {
        "emoji": "📋",
        "os": ["darwin"],
        "requires": { "bins": ["memo"], "env": ["ANTHROPIC_AUTH_TOKEN", "DISCORD_BOT1_TOKEN"] }
      }
  }
---

# Plan计划日报 (Proactive Plan Brief)

每日早晨读取「Plan计划」Apple Notes 备忘录，提取昨日日期块内容，由 AI 整理成简洁播报推送。

## 备忘录结构约定

```
「0226」
任务1
任务2

「0225」
任务A
任务B
```

格式：`「MMDD」` 作为日期块标题，下方为当日计划条目。

## 执行流程

1. 调用 `memo notes --view` 读取「Plan计划」全量内容
2. 解析 `「MMDD」` 日期块，提取昨天对应的块
3. 若无昨日内容则提示"昨日无计划记录"
4. AI 对内容进行简洁解读，输出播报格式
5. 推送到 Discord + Telegram

## 输入参数

```json
{
  "noteName": "Plan计划",
  "channelId": "1469204772379693222",
  "telegramChatId": "-1003855994917"
}
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| noteName | string | "Plan计划" | 备忘录名称 |
| channelId | string | DEFAULT_DISCORD_CHANNEL_ID | Discord 频道 ID |
| telegramChatId | string | DEFAULT_TELEGRAM_CHAT_ID | Telegram Chat ID |

## 输出样例

```
📋 Plan计划日报 | 2026-02-25（周三）

昨日计划（0225）：
• 优化摩尔线程的 PPT
• 完成 JPRobot 后空翻训练和 MoE
• 完成用手机使用 JPClaw 进行编程的能力并全面测试

---
JPClaw Plan日报 · 自动生成
```

## 环境依赖

- `memo` CLI：`brew install antoniorodr/memo/memo`
- 系统权限：终端需获得控制 Notes.app 的自动化权限
- `ANTHROPIC_AUTH_TOKEN` - AI 解读
- `DISCORD_BOT1_TOKEN` / `DISCORD_TOKEN` - Discord 推送
- `TELEGRAM_BOT1_TOKEN` - Telegram 推送
