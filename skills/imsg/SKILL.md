---
name: imsg
description: iMessage/SMS 命令行工具。支持列出对话、查看历史消息、实时监听和发送消息。适用于"发短信"、"查看 iMessage"、"监听消息"、"发送图片"等查询。仅支持 macOS,需要 Messages.app 授权。基于 imsg CLI。
homepage: https://imsg.to
metadata:
  {
    "openclaw":
      {
        "emoji": "📨",
        "os": ["darwin"],
        "requires": { "bins": ["imsg"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/imsg",
              "bins": ["imsg"],
              "label": "Install imsg (brew)",
            },
          ],
      },
  }
---

# imsg Actions

## Overview

Use `imsg` to read and send Messages.app iMessage/SMS on macOS.

Requirements: Messages.app signed in, Full Disk Access for your terminal, and Automation permission to control Messages.app for sending.

## Inputs to collect

- Recipient handle (phone/email) for `send`
- `chatId` for history/watch (from `imsg chats --limit 10 --json`)
- `text` and optional `file` path for sends

## Actions

### List chats

```bash
imsg chats --limit 10 --json
```

### Fetch chat history

```bash
imsg history --chat-id 1 --limit 20 --attachments --json
```

### Watch a chat

```bash
imsg watch --chat-id 1 --attachments
```

### Send a message

```bash
imsg send --to "+14155551212" --text "hi" --file /path/pic.jpg
```

## Notes

- `--service imessage|sms|auto` controls delivery.
- Confirm recipient + message before sending.

## Ideas to try

- Use `imsg chats --limit 10 --json` to discover chat ids.
- Watch a high-signal chat to stream incoming messages.
