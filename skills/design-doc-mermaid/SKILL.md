---
name: design-doc-mermaid
description: 设计文档生成工具。根据需求生成架构/设计文档和 Mermaid 图表（流程图/时序图/类图/ER图/状态图）。支持自动生成高质量领域图表、保存到文件。适用于"生成XX架构图"、"设计XX流程图"、"创建XX时序图"、"画XX类图"、"ER图XX"等查询。返回 Mermaid 代码和 Markdown 文档。
---

# Design Doc Mermaid

## Purpose
Turn a requirement or idea into a concise design doc plus Mermaid diagram code.

## Input
JSON fields:
- `requirement` (required): natural language requirement/problem statement
- `diagramType` (optional): `flowchart | sequence | class | er | state`
- `outputPath` (optional): save markdown output under `sessions/` or `assets/`
- `title` (optional)

Plain text input is treated as `requirement`.

## Output
JSON:
- `ok`
- `title`
- `diagramType`
- `mermaid`
- `markdown`
- `savedPath` (when `outputPath` provided)

## Notes
- If a provider is configured, this skill generates higher-quality domain-specific diagrams.
- Without provider config, it falls back to deterministic templates.
