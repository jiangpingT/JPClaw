---
name: transcript-fast
description: YouTube 字幕提取工具。快速获取 YouTube 视频字幕/转录文本，支持时间戳分段、语言偏好选择（中文/英文）、纯文本输出。适用于"获取YouTube字幕"、"提取XX视频文字"、"下载字幕"、"转录YouTube"等查询。支持 watch/shorts/embed/youtu.be 链接，最多800个分段。
---

# Transcript Fast

## Purpose
Fetch transcript/captions from a YouTube URL quickly, with language preference and timestamped segments.

## Input
JSON fields:
- `url` (required): YouTube watch/shorts/embed/youtu.be link
- `languages` (optional): preferred language order, default `["zh-Hans","zh-Hant","zh","en"]`
- `maxSegments` (optional): default `800`
- `joinText` (optional, default `true`): include combined plain text

## Output
JSON:
- `ok`
- `videoId`
- `language`
- `trackName`
- `segmentCount`
- `segments`: `[{startMs,durationMs,text}]`
- `text` (when `joinText=true`)

## Notes
- Uses public YouTube player caption track metadata from the video page.
- If the video has no captions or is unavailable, returns a structured error.
