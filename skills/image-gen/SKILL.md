---
name: image-gen
description: AI 图像生成工具。通过多种 AI 模型（DALL-E 3、Gemini 3 Pro Image）生成高质量图片。支持多提供商路由（MiningLamp网关/Gemini/OpenAI）、尺寸设置（1024x1024等）、质量选择（标准/高清）、预算控制、自动重试和跨平台回退。适用于"生成XX图片"、"画XX图"、"帮我画XX"、"帮我做XX插图"、"创建XX图像"、"设计XX图标"、"绘制XX"等**明确要求生成或绘制图像**的查询。注意：仅用于创作新图像，不适用于信息搜索。优先使用 MiningLamp 网关（免费），支持 Gemini 和 OpenAI 备用路由。
---

# Image Generation (Unified)

Use unified params:
- `provider`: `auto|mininglamp|gemini|openai` (auto 优先使用 mininglamp)
- `model`: optional override
- `quality`: `standard|high`
- `budget_mode`: `free_first|quality_first`

Input JSON example:

```json
{
  "prompt": "A modern office lobby in warm morning light",
  "provider": "auto",
  "model": "",
  "quality": "high",
  "budget_mode": "free_first",
  "filename": "sessions/media/images/lobby.png",
  "size": "1024x1024"
}
```

Behavior:
- `free_first`: prefer Gemini free-tier route; if budget over limit then auto-downgrade or reject by config.
- `quality_first`: prefer high-quality route (`gpt-image-1` by default).
- Retry + fallback:
  - primary route retries on transient errors
  - if still fails, auto-fallback to the other provider (default enabled)

Required env:
- For MiningLamp route: `MININGLAMP_GATEWAY_API_KEY` (推荐，免费)
- For Gemini route: `GEMINI_API_KEY`
- For OpenAI route: `OPENAI_API_KEY`
