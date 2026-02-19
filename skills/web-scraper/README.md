# web-scraper

Fetch a URL and extract title + text snippet. Optional diff mode.

## Input
JSON string.

## Output
JSON with title/snippet. If mode=diff, includes changed flag.

## Example
```json
{"url":"https://example.com","mode":"diff","storePath":"sessions/web-monitor/index.json"}
```

```json
{"urls":["https://example.com","https://example.org"],"mode":"summarize","maxSentences":3}
```
