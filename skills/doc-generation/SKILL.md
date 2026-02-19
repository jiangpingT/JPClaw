---
name: doc-generation
description: 文档生成工具。生成 Markdown 格式的报告、文档、笔记、幻灯片大纲，支持自动写入文件。支持标题、摘要、章节、要点列表、附录等结构化内容。适用于"生成XX文档"、"创建XX报告"、"写一份XX说明"、"制作XX幻灯片大纲"等查询。支持报告模式和幻灯片模式，自动格式化 H1/H2 标题。
---

# Doc Generation

# Document Generation

## Purpose
Generate a Markdown report or slide outline and optionally write to file.

## Input
JSON fields:
- `title`
- `summary`
- `sections`: [{ title, content, bullets[] }]
- `appendix`
- `mode` or `action`: report | slides (default: report)
- `outputPath`: if set, write markdown to this path

## Output
Markdown string, or `written: <path>` if outputPath is set.

## Guidance
- Keep headings as H1/H2.
- For slides mode, treat sections as slide blocks.
