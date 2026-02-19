---
name: scheduled-tasks
description: 定时任务工具。创建本地定时任务定义，支持自动化工作流调度。支持定时规则（schedule/rrule）、执行动作（命令/技能）、下次运行时间设置。适用于"定时执行XX"、"每天XX点运行XX"、"创建定时任务"、"自动化XX任务"等查询。任务定义保存到本地 JSON 文件。
---

# Scheduled Tasks

# Scheduled Tasks

## Purpose
Create local schedule definitions for automation workflows.

## Input
JSON fields:
- `name`
- `schedule` or `rrule`
- `action` or `command` or `skill`
- `payload` (optional)
- `outputPath` (default: sessions/schedules/tasks.json)
- `nextRunAt` / `dueAt` / `at`

## Output
`scheduled: <name> -> <file>`

## Guidance
- Append entry to the JSON list at outputPath.
