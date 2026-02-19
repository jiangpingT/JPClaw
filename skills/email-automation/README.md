# email-automation

Local email automation: draft, queue, categorize, and reminders.

## Input
JSON string.

## Output
String summary or JSON.

## Example
```json
{"action":"draft","to":"user@example.com","subject":"Status","body":"Weekly update"}
```

```json
{"action":"categorize","items":[{"subject":"Invoice 123","body":"Payment due"}]}
```

```json
{"action":"remind","subject":"Follow up","body":"Ping vendor","dueAt":"2026-02-10T09:00:00Z"}
```

```json
{"action":"send","to":"user@example.com","subject":"Hi","body":"Hello","smtpHost":"smtp.example.com","smtpUser":"user","smtpPass":"pass","smtpPort":587}
```
