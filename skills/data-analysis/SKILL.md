---
name: data-analysis
description: 数据分析工具。分析 CSV/TSV/JSON 文件，生成摘要统计、基础统计信息（最小值/最大值/平均值）、数据清洗（去重/删除空行）。适用于"分析XX数据"、"统计XX"、"清洗XX数据"、"查看XX文件摘要"、"数据概览"等查询。支持自定义分隔符、表头检测、输出清洗后的 CSV。
---

# Data Analysis

# Data Analysis (CSV/TSV/JSON)

## Purpose
Summarize tabular data or clean it and write a cleaned CSV.

## Input
Accept JSON or plain text.

JSON fields:
- `path`: local file path (csv/tsv/json)
- `format`: csv | tsv | json (optional, inferred from extension)
- `header`: boolean, whether first row is headers (default: true)
- `action`: summary | clean (default: summary)
- `delimiter`: override delimiter for csv
- `rows`, `headers`: direct data input (optional)
- `dedupe`: boolean (default: true)
- `dropEmpty`: boolean (default: true)
- `outputPath`: where to write cleaned csv (default: sessions/cleaned.csv)

## Output
If action=clean: JSON { written, rows }.
If action=summary: JSON { rows, columns, headers, stats } with numeric min/max/avg and empty counts.

## Guidance
- Use read_file to load data and write_file to save output.
- Validate that path exists when provided.
