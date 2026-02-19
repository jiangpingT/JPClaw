---
name: slack
description: Slack 消息集成工具。在 Slack 频道和私信中发送消息、上传文件、管理频道、查看消息历史。适用于"发送Slack消息"、"Slack通知"、"上传到Slack"、"查看Slack消息"等查询。需要配置 Slack App token 和权限。
---

# Slack

Send messages, upload files, and manage Slack channels and conversations.

## Purpose
Integrate with Slack workspaces for automated messaging and channel management.

## Supported Features
- Send messages to channels and DMs
- Upload files and attachments
- Read message history
- Manage channels (create, archive, etc.)
- React to messages
- Slack App integration

## Setup
Requires Slack App token with appropriate scopes (chat:write, files:write, channels:read, etc.)

## Input
Target channel/user, message content, optional attachments

## Output
Confirmation of message sent or API response
