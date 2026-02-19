---
name: map-share-links
description: 地图分享链接生成工具。为指定地点生成各种地图平台（高德/百度/谷歌）的分享/搜索链接。支持坐标直达或地址搜索。适用于"生成XX地图链接"、"分享XX位置"、"地图链接XX"等查询。返回多个地图平台的 Markdown 链接。
---

# Map Share Links

# Map Share Links

## Purpose
Generate share/search links for map providers.

## Input
JSON fields:
- `name`, `address`
- `lat`, `lng` (optional)
- `providers`: list like ["amap","baidu","google"]

## Output
Markdown with links for each provider.

## Guidance
- If lat/lng provided, use direct coordinates; otherwise use search URLs.
