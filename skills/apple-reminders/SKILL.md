---
name: apple-reminders
description: 访问和管理 macOS 苹果提醒事项（Apple Reminders）。适用于"查看提醒"、"查看今日提醒"、"待办提醒"、"创建提醒"、"完成提醒"、"提醒清单"等请求。仅支持 macOS，需要 Apple Reminders 访问权限。注意：这是 Apple 自带的提醒事项，不是 Things 3。依赖：remindctl（brew install steipete/tap/remindctl）。
---

# Apple Reminders

通过 JXA (JavaScript for Automation) 操作 macOS 内置提醒事项应用。

## 输入

JSON 字符串，包含 `action` 字段：

```json
{"action": "lists"}
{"action": "today"}
{"action": "pending"}
{"action": "upcoming"}
{"action": "overdue"}
{"action": "all"}
{"action": "create", "title": "买菜", "listName": "购物", "due": "2025-01-15T09:00:00"}
{"action": "complete", "reminderName": "买菜"}
{"action": "delete", "reminderName": "买菜"}
```

## 支持的操作

- `lists` - 列出所有提醒事项清单
- `today` - 今日到期的提醒
- `pending` - 所有未完成提醒
- `upcoming` - 未来 7 天内的提醒
- `overdue` - 已过期未完成的提醒
- `completed` - 已完成的提醒
- `all` - 所有提醒（不过滤）
- `create` - 创建新提醒
- `complete` - 标记提醒完成
- `delete` - 删除提醒
