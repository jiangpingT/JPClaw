---
name: camera-capture
description: 用电脑内置前置摄像头（MacBook FaceTime Camera）录制4秒视频并发送给用户。当用户说"电脑摄像头"相关指令时调用（如"电脑摄像头录一段发我"、"电脑开摄像头看看"、"用电脑摄像头拍一下家里"、"电脑录个视频"）。"电脑"是关键触发词，本工具只用电脑内置摄像头，不涉及网络摄像头。
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
