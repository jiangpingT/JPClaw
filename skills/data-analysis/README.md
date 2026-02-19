# data-analysis

CSV/TSV/JSON summarization with basic stats.

## Input
JSON string.

## Output
JSON summary with row/column counts and per-column stats.

## Example
```json
{"path":"data/sales.csv","format":"csv"}
```

```json
{"action":"clean","path":"data/raw.csv","outputPath":"sessions/cleaned.csv","dedupe":true,"dropEmpty":true}
```
