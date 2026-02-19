# entity-intro

Generalized introduction skill for any person/company.

## Input (JSON)
```json
{
  "person": "姜平",
  "company": "明略科技",
  "includeMemory": true,
  "web": {
    "url": "https://example.com"
  }
}
```

## Notes
- Uses local memory under `sessions/memory/users/`.
- Optional `web.url` fetches a snippet when `network` permission is available.
