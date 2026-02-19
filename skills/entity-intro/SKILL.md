---
name: entity-intro
description: 实体介绍生成工具。使用本地记忆和可选的网页摘要，生成人物/公司的通用介绍。从本地记忆读取用户信息，可选从网页提取补充内容。适用于"介绍XX"、"XX是谁"、"XX公司简介"、"生成XX的介绍"等查询。返回 Markdown 格式的要点列表和网页摘要。
---

# Entity Intro

# Entity Intro

## Purpose
Generate a generalized introduction for a person/company using local memory and optional web snippet.

## Input
JSON fields:
- `person` or `name`
- `company` or `org`
- `query`
- `includeMemory` (default: true)
- `web.url` (optional)

## Output
Markdown with:
- title
- bullet points from local memory
- optional web snippet
- request for more context if insufficient data

## Guidance
- Read local memory under sessions/memory/users.
- If web.url provided, fetch and extract a short snippet.
