---
name: mic-listen
description: 用电脑麦克风录音8秒并转文字，告诉你电脑前有谁在说话、说了什么。当用户想知道电脑周围的声音/对话时调用（如"电脑听一下周围在说什么"、"电脑录一下声音看看谁在说话"、"电脑开麦克风听听"、"帮我用电脑听一下前面有人说话吗"）。"电脑"是触发前缀，录音后通过 Whisper 转文字再返回给用户。
---

# Mic Listen Skill

录制 MacBook Pro 内置麦克风 8 秒音频，经 Whisper STT 转文字后返回：
- `transcript`：原始转录文字
- `summary`：AI 一句话解读（有没有人、说了什么）

## Input

无需参数（时长固定 8 秒，设备固定 MacBook Pro麦克风 device[1]）。

## Output

```json
{
  "ok": true,
  "transcript": "原始转录文字",
  "summary": "有人在说：xxx"
}
```

## 依赖

- `ffmpeg`（brew install ffmpeg）
- Whisper STT API（llm-guard.mininglamp.com）
- macOS 麦克风权限
- 临时文件录完即删，不保留
