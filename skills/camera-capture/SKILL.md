---
name: camera-capture
description: 用电脑前置摄像头录制4秒视频并发送给用户。当用户要求录制/拍摄摄像头画面时调用（如"电脑摄像头录一段发我"、"电脑用摄像头拍一下"、"电脑开摄像头看看"、"帮我用电脑摄像头录个视频"）。"电脑"是触发前缀，视频会直接以附件形式发送给用户。
---

# Camera Capture Skill

使用 MacBook Pro 前置摄像头（AVFoundation device [0]）录制 4 秒 MP4 视频，直接发送给 Discord / Telegram 用户。

## Input

无需参数（duration 固定 4 秒，设备固定前置摄像头）。

## Output

channel handler 检测到 `{"type":"file_attachment","mimeType":"video/mp4",...}` 后自动发送视频。

## 依赖

- `ffmpeg`（brew install ffmpeg）
- macOS 摄像头权限
- 视频保存在 `sessions/brain/camera/` 下，不自动删除
