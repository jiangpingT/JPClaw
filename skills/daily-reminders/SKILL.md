---
name: daily-reminders
description: 今日提醒事项播报 - 从 macOS Apple 提醒事项拉取今日待办和逾期事项，推送到 Discord + Telegram。适用于「今天有什么提醒」「我的待办」「今日任务」「提醒我做了什么」「提醒事项有哪些」等查询。
---

# Daily Reminders Skill

从 macOS Apple 提醒事项（Reminders）拉取今日待办 + 逾期未完成事项，格式化后推送到 Discord + Telegram。每天 08:30 自动运行，也可手动触发。

## Input

```json
{
  "channelId": "（可选）Discord 频道 ID，默认主频道",
  "telegramChatId": "（可选）Telegram Chat ID，默认主群"
}
```

空 input 也可以，直接用默认配置。

## Output

```json
{
  "ok": true,
  "todayCount": 3,
  "overdueCount": 1,
  "discord": ["message_id"],
  "telegram": ["message_id"]
}
```

## 报告示例

```
📋 今日提醒事项 | 2026-02-24（周二）

⚠️ 逾期未完成（1 条）：
  ☐ 给大宝买书
    📂 家庭

📌 今日待办（2 条）：
  ☐ 产品评审会议 · 10:00
    📂 工作
  ☐ 回邮件给张总
    📂 工作

---
JPClaw 提醒播报 · 自动生成
```

## 数据来源

- `remindctl show today` → 今日到期事项
- `remindctl show overdue` → 逾期未完成事项
- 逾期事项放在最上面（最紧急）

## 依赖

- `remindctl`：`brew install steipete/tap/remindctl`
- macOS 需在「系统设置 → 隐私与安全 → 提醒事项」授权终端访问权限
