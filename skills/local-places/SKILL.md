---
name: local-places
description: 国际版地点搜索Web服务（Google Places API）。通过localhost:8000本地代理服务访问Google Places API，用于国外地点搜索。需要先启动本地服务器（uvicorn），支持两步流程：先解析位置，再搜索地点。适用于需要Web服务架构的国际地点查询场景。需要GOOGLE_PLACES_API_KEY和uv环境。注意：中国地点请用map-poi技能，简单CLI查询请用goplaces技能
homepage: https://github.com/Hyaxia/local_places
metadata:
  {
    "openclaw":
      {
        "emoji": "📍",
        "requires": { "bins": ["uv"], "env": ["GOOGLE_PLACES_API_KEY"] },
        "primaryEnv": "GOOGLE_PLACES_API_KEY",
      },
  }
---

# 📍 Local Places

_Find places, Go fast_

Search for nearby places using a local Google Places API proxy. Two-step flow: resolve location first, then search.

## Setup

```bash
cd {baseDir}
echo "GOOGLE_PLACES_API_KEY=your-key" > .env
uv venv && uv pip install -e ".[dev]"
uv run --env-file .env uvicorn local_places.main:app --host 127.0.0.1 --port 8000
```

Requires `GOOGLE_PLACES_API_KEY` in `.env` or environment.

## Quick Start

1. **Check server:** `curl http://127.0.0.1:8000/ping`

2. **Resolve location:**

```bash
curl -X POST http://127.0.0.1:8000/locations/resolve \
  -H "Content-Type: application/json" \
  -d '{"location_text": "Soho, London", "limit": 5}'
```

3. **Search places:**

```bash
curl -X POST http://127.0.0.1:8000/places/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "coffee shop",
    "location_bias": {"lat": 51.5137, "lng": -0.1366, "radius_m": 1000},
    "filters": {"open_now": true, "min_rating": 4.0},
    "limit": 10
  }'
```

4. **Get details:**

```bash
curl http://127.0.0.1:8000/places/{place_id}
```

## Conversation Flow

1. If user says "near me" or gives vague location → resolve it first
2. If multiple results → show numbered list, ask user to pick
3. Ask for preferences: type, open now, rating, price level
4. Search with `location_bias` from chosen location
5. Present results with name, rating, address, open status
6. Offer to fetch details or refine search

## Filter Constraints

- `filters.types`: exactly ONE type (e.g., "restaurant", "cafe", "gym")
- `filters.price_levels`: integers 0-4 (0=free, 4=very expensive)
- `filters.min_rating`: 0-5 in 0.5 increments
- `filters.open_now`: boolean
- `limit`: 1-20 for search, 1-10 for resolve
- `location_bias.radius_m`: must be > 0

## Response Format

```json
{
  "results": [
    {
      "place_id": "ChIJ...",
      "name": "Coffee Shop",
      "address": "123 Main St",
      "location": { "lat": 51.5, "lng": -0.1 },
      "rating": 4.6,
      "price_level": 2,
      "types": ["cafe", "food"],
      "open_now": true
    }
  ],
  "next_page_token": "..."
}
```

Use `next_page_token` as `page_token` in next request for more results.
