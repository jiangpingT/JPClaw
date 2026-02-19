---
name: insight-summary
description: 文本摘要工具。从长文本中提取关键要点，生成结构化摘要。支持自定义要点数量（默认5个）。适用于"总结XX"、"提取要点"、"归纳XX内容"、"概括XX文章"、"关键信息"等查询。返回 JSON 格式的要点列表。
---

# Insight Summary

# Insight Summary

## Purpose
Extract key points from a long text.

## Input
Plain text or JSON:
- `text`
- `maxPoints` (default: 5)

## Output
JSON: { points: [ ... ] }
