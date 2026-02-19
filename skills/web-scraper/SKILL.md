---
name: web-scraper
description: 网页抓取工具。抓取网页内容并提取结构化数据，支持 HTML 解析、文本提取、内容摘要、变化检测（diff模式）。适用于"抓取XX网页"、"提取XX内容"、"解析XX网站"、"获取XX信息"、"监控XX页面变化"等查询。支持超时控制、字符数限制、单页/多页抓取。
---

# Web Scraper

# Web Scraper

## Purpose
Fetch and extract content from web pages with optional summarize or diff.

## Input
JSON fields:
- `url` or `urls`
- `mode`: extract | summarize | diff
- `timeoutMs`
- `maxChars`, `maxSentences`
- `storePath` (diff mode, default: sessions/web-monitor/index.json)

## Output
JSON with title, snippet, summary, and/or diff status.

## Guidance
- For diff mode, store hash for change detection.
