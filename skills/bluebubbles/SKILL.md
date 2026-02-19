---
name: bluebubbles
description: iMessage 消息管理工具。通过 BlueBubbles 发送和管理 iMessage（推荐的 iMessage 集成方案）。支持发送消息、添加反应（tapback）、编辑/撤回消息、回复线程、发送附件、消息特效、管理群组成员/名称/图标。适用于"发送iMessage"、"回复消息"、"撤回消息"、"添加反应"等查询。需要配置 BlueBubbles 服务器。
metadata: { "openclaw": { "emoji": "🫧", "requires": { "config": ["channels.bluebubbles"] } } }
---

# BlueBubbles Actions

## Overview

BlueBubbles is OpenClaw’s recommended iMessage integration. Use the `message` tool with `channel: "bluebubbles"` to send messages and manage iMessage conversations: send texts and attachments, react (tapbacks), edit/unsend, reply in threads, and manage group participants/names/icons.

## Inputs to collect

- `target` (prefer `chat_guid:...`; also `+15551234567` in E.164 or `user@example.com`)
- `message` text for send/edit/reply
- `messageId` for react/edit/unsend/reply
- Attachment `path` for local files, or `buffer` + `filename` for base64

If the user is vague ("text my mom"), ask for the recipient handle or chat guid and the exact message content.

## Actions

### Send a message

```json
{
  "action": "send",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "message": "hello from OpenClaw"
}
```

### React (tapback)

```json
{
  "action": "react",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "messageId": "<message-guid>",
  "emoji": "❤️"
}
```

### Remove a reaction

```json
{
  "action": "react",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "messageId": "<message-guid>",
  "emoji": "❤️",
  "remove": true
}
```

### Edit a previously sent message

```json
{
  "action": "edit",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "messageId": "<message-guid>",
  "message": "updated text"
}
```

### Unsend a message

```json
{
  "action": "unsend",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "messageId": "<message-guid>"
}
```

### Reply to a specific message

```json
{
  "action": "reply",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "replyTo": "<message-guid>",
  "message": "replying to that"
}
```

### Send an attachment

```json
{
  "action": "sendAttachment",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "path": "/tmp/photo.jpg",
  "caption": "here you go"
}
```

### Send with an iMessage effect

```json
{
  "action": "sendWithEffect",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "message": "big news",
  "effect": "balloons"
}
```

## Notes

- Requires gateway config `channels.bluebubbles` (serverUrl/password/webhookPath).
- Prefer `chat_guid` targets when you have them (especially for group chats).
- BlueBubbles supports rich actions, but some are macOS-version dependent (for example, edit may be broken on macOS 26 Tahoe).
- The gateway may expose both short and full message ids; full ids are more durable across restarts.
- Developer reference for the underlying plugin lives in `extensions/bluebubbles/README.md`.

## Ideas to try

- React with a tapback to acknowledge a request.
- Reply in-thread when a user references a specific message.
- Send a file attachment with a short caption.
