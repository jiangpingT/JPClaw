---
name: notify
description: 推送通知到 Discord 和 Telegram。适用于「通知我」「发消息给我」「告诉我完成了」「后台任务完成后通知」等场景。后台 coding-agent 任务结束时用 curl 调用。
---

# Notify Skill

向 Discord + Telegram 同时推送消息。专为后台 coding-agent 任务完成后的主动通知设计。

## Input

```json
{
  "message": "✅ 完成：描述做了什么",
  "channelId": "（可选）Discord 频道 ID，默认用主频道",
  "telegramChatId": "（可选）Telegram Chat ID，默认用主群"
}
```

## Output

```json
{
  "ok": true,
  "discord": ["message_id_1"],
  "telegram": ["message_id_1"]
}
```

## 用法：后台任务完成后通知

在 coding-agent 的 prompt 末尾加上这段 curl，任务结束自动推送通知：

```bash
curl -s -X POST http://localhost:18790/skills/run \
  -H "Content-Type: application/json" \
  -d '{"name":"notify","input":"{\"message\":\"✅ 完成：[简要描述]\"}"}'
```

### 完整后台任务模板

```bash
bash pty:true workdir:~/project background:true command:"claude '你的任务描述。

完成后运行以下命令通知我：
curl -s -X POST http://localhost:18790/skills/run -H \"Content-Type: application/json\" -d \"{\\\"name\\\":\\\"notify\\\",\\\"input\\\":\\\"{\\\\\\\"message\\\\\\\":\\\\\\\"✅ 完成：[摘要]\\\\\\\"}\\\"}\""
```

## 依赖

- `DISCORD_BOT1_TOKEN`：Discord Bot Token
- `TELEGRAM_BOT1_TOKEN`：Telegram Bot Token
