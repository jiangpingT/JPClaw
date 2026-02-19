---
name: slide-outline
description: 幻灯片大纲生成工具。从主题或要点列表创建幻灯片大纲。支持标题、目标、章节结构生成。适用于"创建XX幻灯片大纲"、"生成XX演示文稿"、"制作XX PPT大纲"等查询。注意：已废弃，推荐使用 doc-generation 的 mode=slides 模式。返回 Markdown 格式的幻灯片大纲。
---

# Slide Outline

# Slide Outline

## Purpose
Create a slide outline from a topic or explicit sections.

## Status
Deprecated as a standalone skill. Prefer `doc-generation` with `mode=slides`.

## Replacement Example
```json
{"mode":"slides","title":"Pitch Deck","slides":[{"title":"Problem","bullets":["A","B"]}]}
```

## Input
JSON fields:
- `topic`
- `goal`
- `sections`: [{ title, bullets[] }]

## Output
Markdown outline with H2 sections and bullets.
