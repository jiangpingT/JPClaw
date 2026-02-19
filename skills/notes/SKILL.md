---
name: notes
description: 笔记统一入口工具。路由到不同的笔记系统（Apple Notes/Bear Notes/Notion/Obsidian）。支持创建、追加、搜索、列表、更新、删除笔记。适用于"添加笔记到XX"、"搜索笔记"、"更新XX笔记"、"删除笔记"等查询。根据指定的 target 参数路由到对应的笔记系统。
---

# Notes (Unified Entry)

## Purpose
Provide a single entry point for notes/knowledge-base tasks and route to the appropriate backend.

## Targets
- `apple-notes` (macOS Notes via memo CLI)
- `bear-notes` (Bear via grizzly CLI)
- `notion` (Notion API)
- `obsidian` (local vault operations)

## Input
JSON fields:
- `target`: apple-notes | bear-notes | notion | obsidian
- `action`: create | append | search | list | update | delete
- `payload`: action-specific data (title, body, tags, ids)

## Output
Text or JSON depending on the target tool.

## Guidance
- If `target` is missing, ask which notes system to use.
- For Notion, require API key and target page/database id.

## Usage
```json
{"target":"apple-notes","action":"create","payload":{"title":"Idea","body":"..."}}
```
