---
name: email-automation
description: 邮件自动化工具。草拟邮件、发送邮件（SMTP）、邮件分类、创建邮件提醒、队列管理（本地发件箱）。适用于"发送邮件给XX"、"草拟邮件"、"邮件提醒XX时间"、"分类邮件"、"邮件归档"等查询。支持多收件人（to/cc/bcc）、SMTP配置、发送失败自动排队、提醒时间设置。
---

# Email Automation

# Email Automation

## Purpose
Draft, queue, categorize, or send emails via SMTP; create reminders.

## Input
JSON fields:
- `action`: draft | send | categorize | remind (default: draft)
- `to`, `cc`, `bcc` (string or array)
- `subject`, `body`
- `items`: list for categorize [{ subject, body }]
- `dueAt` or `at`: reminder time

SMTP env:
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`
- `SMTP_FROM`, `SMTP_SECURE`, `SMTP_STARTTLS`

## Output
- draft: `draft: <sessions/outbox/*.json>`
- send: JSON { sent: true, ... } or `send_failed_queued: <file>`
- categorize: JSON { categorized: [...] }
- remind: `reminder_saved: <sessions/reminders/reminders.json>`

## Guidance
- If SMTP send fails, queue into sessions/outbox with status queued.
