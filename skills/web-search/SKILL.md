---
name: web-search
description: 网络搜索工具。使用 Brave/DuckDuckGo 多源聚合搜索引擎，返回结构化摘要和来源链接。支持新闻搜索、普通网页搜索、实时信息检索。适用于"搜索XX"、"查找XX信息"、"XX最新新闻"、"帮我找XX资料"、"XX公开信息"、"XX怎么样"等查询。支持中英文搜索，自动去重和排序。
---

# Web Search

## Purpose
Run web search quickly through JPClaw's built-in retrieval pipeline and return a concise result summary.

## Input
JSON fields:
- `query` (required)
- `traceId` (optional)
- `provider` (optional): `auto | brave | builtin` (default `auto`)
- `count` (optional): Brave result count (default `5`)

Plain text input is treated as `query`.

## Output
JSON:
- `ok`
- `traceId`
- `query`
- `result` (concise summary text)
- `provider` (`brave` or `builtin`)
- `rows` (Brave mode structured rows)

## Notes
- This skill reuses the existing core search implementation in `dist/tools/web.js`.
- If weather-like keywords are detected, it may route to weather retrieval automatically.
- For Brave mode, set `BRAVE_SEARCH_API_KEY`.
