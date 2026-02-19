---
name: workflow-runner
description: 工作流执行工具。生成结构化工作流定义和执行计划，支持多步骤编排。每个步骤包含名称、动作、输入参数。适用于"创建工作流XX"、"执行多步骤任务"、"编排XX流程"、"自动化XX工作流"等查询。自动生成工作流ID和时间戳，返回完整的工作流结构。
---

# Workflow Runner

# Workflow Runner

## Purpose
Generate a structured workflow definition from steps.

## Input
JSON fields:
- `name`
- `steps`: [{ name, action, input }]

## Output
JSON workflow with generated ids, createdAt, and step structure.
