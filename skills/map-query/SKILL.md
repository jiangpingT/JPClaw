---
name: map-query
description: 地图信息查询工具。查询地点信息和距离估算。支持关键词搜索、城市筛选、结果数限制。适用于"查找地点"、"距离查询"、"周边搜索"等查询。优先使用 goplaces 或 local-places 后端。
---

# Map Query

# Map Query

## Purpose
Find places and return basic location details and distance hints.

## Input
JSON fields:
- `keyword` (what to search)
- `location` (reference address/place)
- `city`
- `maxResults`

## Output
Markdown list of places with address and approximate distance.

## Guidance
- Prefer `goplaces` when Google Places CLI is available.
- Prefer `local-places` when local proxy is running.
- Otherwise, provide a best-effort guess and ask for API key or install steps.
- Keep results concise and practical.
