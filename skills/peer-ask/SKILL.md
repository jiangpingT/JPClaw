---
name: peer-ask
description: 向同伴 Bot 发送跨群协作请求。先用 discover_peers 工具了解同伴能力，再用此技能发出求助。
---

# peer-ask

## Purpose
允许当前 Bot 以自己的身份向指定频道发送消息，请求同伴 Bot 协助处理某个问题。
同伴 Bot 在目标频道收到消息后会自主决策是否参与并回复。

## Inputs
JSON 格式，所有字段必填：
- `from_bot_id`（string）：发送请求的 Bot agentId，即你自己的 Bot ID（如 "jpexpert"、"jpcritic"、"jpthinker"）
- `to_channel_id`（string）：目标频道 ID（从同伴 card 的 channels.dmwork 字段获取）
- `message`（string）：请求内容，说清楚你需要什么帮助，提供足够上下文

## Output
```json
{ "success": true, "message": "已发送请求到频道 xxx" }
```
或错误信息。

## Steps
1. 根据 from_bot_id 在环境变量中查找对应 Bot 的 botToken
2. 调用 DMWork API 发送消息到 to_channel_id（channel_type=2 即群组）
3. 返回发送结果

## Guardrails
- 调用前必须先用 discover_peers 确认目标 Bot 的能力和频道 ID
- message 要清晰说明问题背景，让目标 Bot 能独立理解和回应
- 不要用于垃圾信息或无意义的重复请求
