---
name: goplaces
description: 国际版地点查询CLI工具（Google Places API）。专门用于国外地点搜索，使用goplaces命令行工具进行文本搜索、地点详情、地址解析和评论查询。支持营业中过滤、最低评分、位置偏向、半径搜索、分页、价格等级过滤。适用于"搜索国外XX地点"、"查找纽约/伦敦/东京附近XX"等国际地点查询。需要GOOGLE_PLACES_API_KEY。注意：中国地点请用map-poi技能（高德地图API）
homepage: https://github.com/steipete/goplaces
metadata:
  {
    "openclaw":
      {
        "emoji": "📍",
        "requires": { "bins": ["goplaces"], "env": ["GOOGLE_PLACES_API_KEY"] },
        "primaryEnv": "GOOGLE_PLACES_API_KEY",
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/goplaces",
              "bins": ["goplaces"],
              "label": "Install goplaces (brew)",
            },
          ],
      },
  }
---

# goplaces

Modern Google Places API (New) CLI. Human output by default, `--json` for scripts.

Install

- Homebrew: `brew install steipete/tap/goplaces`

Config

- `GOOGLE_PLACES_API_KEY` required.
- Optional: `GOOGLE_PLACES_BASE_URL` for testing/proxying.

Common commands

- Search: `goplaces search "coffee" --open-now --min-rating 4 --limit 5`
- Bias: `goplaces search "pizza" --lat 40.8 --lng -73.9 --radius-m 3000`
- Pagination: `goplaces search "pizza" --page-token "NEXT_PAGE_TOKEN"`
- Resolve: `goplaces resolve "Soho, London" --limit 5`
- Details: `goplaces details <place_id> --reviews`
- JSON: `goplaces search "sushi" --json`

Notes

- `--no-color` or `NO_COLOR` disables ANSI color.
- Price levels: 0..4 (free → very expensive).
- Type filter sends only the first `--type` value (API accepts one).
