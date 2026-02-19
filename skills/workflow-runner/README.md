# workflow-runner

Generate workflow definitions and execution plans.

## Input
JSON string.

## Output
JSON workflow definition.

## Example
```json
{"name":"daily-ops","steps":[{"name":"fetch","action":"skill:web-scraper"},{"name":"summarize","action":"skill:insight-summary"}]}
```
