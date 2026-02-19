---
name: social-stats
description: 通用社交媒体数据提取工具。通过 URL 抓取社交媒体个人主页的关注/粉丝/点赞/评论等统计数据。适用于"抓取社交数据"、"粉丝统计"、"互动数据分析"等查询。基于 Playwright 浏览器自动化,支持自定义标签关键词。
---

# Social Stats

## Purpose
Given a profile URL, open the page in a real browser (Playwright) and extract common social stats.

## Input
JSON fields:
- `url` (required)
- `labels` (optional): customize keywords, e.g.
  - `followers`: ["被关注", "粉丝", "关注者"]
  - `following`: ["关注"]
  - `likes`: ["赞", "点赞"]
  - `comments`: ["评论"]
  - `praises`: ["夸夸"]
- `storageStatePath` (optional): Playwright storage state path
- `timeoutMs` (optional)

## Output
JSON:
- `url`
- `counts` (followers/following/likes/comments/praises, may be null)
- `textSample`
- `fetchedAt`

## Notes
- This skill uses `browser-automation` for page fetch and extract.
- If login required, provide `storageStatePath`.
