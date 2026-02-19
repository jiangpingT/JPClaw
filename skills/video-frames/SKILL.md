---
name: video-frames
description: AI视频生成工具。使用 OpenAI Sora 2 Pro 或 Google Gemini Veo 3.1 生成高质量视频。支持时长控制（默认8秒）、宽高比设置（16:9等）、质量选择、预算模式（免费优先/质量优先）。适用于"生成XX视频"、"创建XX动画"、"制作XX视频片段"、"视频演示XX"等查询。自动路由到最佳模型，支持重试和跨平台回退。
---

# Video Generation (Unified)

This skill now supports unified routing params:
- `provider`: `auto|gemini|openai`
- `model`: optional override
- `quality`: `standard|high`
- `budget_mode`: `free_first|quality_first`

Input JSON example:

```json
{
  "prompt": "A drone shot flying over a smart city at sunrise",
  "provider": "auto",
  "model": "",
  "quality": "high",
  "budget_mode": "quality_first",
  "duration_seconds": 8,
  "aspect_ratio": "16:9"
}
```

Routing defaults:
- `free_first`: Gemini route first (free-tier strategy).
- `quality_first`: OpenAI route first (`sora-2-pro`) or Gemini `veo-3.1` when provider explicitly set.

Notes:
- Video APIs differ by vendor and may be async jobs.
- Configure endpoint env vars for your account/runtime.
- Built-in retry and cross-provider fallback are enabled by default.
