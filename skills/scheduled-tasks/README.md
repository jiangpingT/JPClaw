# scheduled-tasks

Create local schedule definitions for automation workflows.

## Input
JSON string.

## Output
String indicating where the schedule entry was written.

## Example
```json
{"name":"daily-report","schedule":"FREQ=DAILY;BYHOUR=9;BYMINUTE=0","action":"run:skills/doc-generation"}
```

Run the scheduler:
```sh
node --import tsx src/js/cli/index.ts scheduler
```
