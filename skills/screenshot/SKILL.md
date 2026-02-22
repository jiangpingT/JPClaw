---
name: screenshot
description: 截取当前电脑屏幕并发送图片给用户。当用户明确要求截屏、截图、看一下屏幕/电脑当前状态时调用（如"电脑截个屏"、"电脑截屏发我"、"帮我看看电脑现在屏幕"、"截个屏"、"截屏发我"、"帮我看看现在屏幕"、"请用电脑截屏发给我"）。截图会直接以图片形式发送回给用户。
---

# Screenshot Skill

截取当前 macOS 屏幕，直接以图片附件发送给 Discord / Telegram 用户。

## Input

JSON 字段（均可选）：
- `caption`：图片说明文字，默认"📸 电脑截屏 {时间}"

## Output

channel handler 检测到 `{"type":"file_attachment",...}` 后自动发送图片，用户无需关心返回格式。

## 限制

- 仅支持 macOS（依赖 `screencapture`）
- 截图保存在 `sessions/brain/screenshots/` 下，发送后不自动删除（保留供审计）
