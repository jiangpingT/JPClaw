# doc-generation

Generate Markdown reports and optionally write to file.

## Input
JSON string.

## Output
Markdown or a "written" message.

## Example
```json
{"title":"Weekly Report","summary":"Highlights...","sections":[{"title":"Metrics","bullets":["A","B"]}],"outputPath":"docs/report.md"}
```

```json
{"mode":"slides","title":"Pitch Deck","slides":[{"title":"Problem","bullets":["Pain 1","Pain 2"]},{"title":"Solution","bullets":["Approach"]}]}
```
