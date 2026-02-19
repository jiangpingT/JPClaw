# JPClaw 技能路由测试报告

**生成时间**: 2026-02-15 10:02:41

## 测试概览

### ✅ Test #1: web-search

- **查询**: "搜索一下今天的科技新闻"
- **期望**: web-search
- **实际**: web-search
- **置信度**: 0.88
- **结果**: 通过 ✅

### ✅ Test #2: map-poi

- **查询**: "附近有什么咖啡馆"
- **期望**: map-poi
- **实际**: map-poi
- **置信度**: 0.92
- **结果**: 通过 ✅

### ❌ Test #3: openai-image-gen

- **查询**: "生成一张未来城市的图片"
- **期望**: openai-image-gen
- **实际**: unknown (置信度: 0.45)
- **结果**: 失败 ❌
- **原因**: 未能路由到正确技能

### ❌ Test #4: browser-automation

- **查询**: "打开网页 https://github.com 并截图"
- **期望**: browser-automation
- **实际**: unknown (置信度: 0.45)
- **结果**: 失败 ❌
- **原因**: 未能路由到正确技能

### ❌ Test #5: web-scraper

- **查询**: "抓取 https://news.ycombinator.com 的标题"
- **期望**: web-scraper
- **实际**: unknown (置信度: 0.45)
- **结果**: 失败 ❌
- **原因**: 未能路由到正确技能

