---
name: browser-automation
description: 浏览器自动化工具。使用 Playwright 驱动 Chromium 浏览器进行复杂网页交互操作：点击元素、填写表单、滚动页面、提取文本、下载文件、监听网络请求。重点用于需要自动化操作的场景（如填表、点击、登录）。适用于"自动填写XX表单"、"登录XX网站"、"点击XX按钮"、"模拟用户操作"等查询。注意：如只需截图请用web-screenshot技能。
---

# Browser Automation (Playwright)

## Purpose
Provide real browser interaction for demos: open URLs, click elements, fill inputs, scroll, take screenshots, and extract page text.

## Inputs
Accept JSON only. Suggested schema:

```json
{
  "url": "https://example.com",
  "actions": [
    { "type": "wait", "ms": 1000 },
    { "type": "goto", "url": "https://example.com/docs", "waitUntil": "domcontentloaded" },
    { "type": "click", "selector": "text=Docs" },
    { "type": "fill", "selector": "input[name=q]", "text": "query" },
    { "type": "press", "selector": "input[name=q]", "key": "Enter" },
    { "type": "wait_for_url", "url": "**/search**", "timeoutMs": 15000 },
    { "type": "wait_for_request", "urlContains": "/api/feed", "method": "GET", "timeoutMs": 12000 },
    { "type": "wait_for_response", "urlContains": "/api/feed", "status": 200, "timeoutMs": 12000 },
    { "type": "hover", "selector": ".menu" },
    { "type": "download_click", "selector": "text=导出", "path": "sessions/downloads/report.csv" },
    { "type": "scroll", "x": 0, "y": 1200 },
    { "type": "screenshot", "path": "sessions/screens/demo.png", "fullPage": true },
    { "type": "extract", "selector": "main", "maxChars": 1200 },
    { "type": "extract_all", "selector": "a", "maxItems": 20, "maxChars": 160 },
    { "type": "extract_attr", "selector": "a", "attr": "href", "maxItems": 20, "maxChars": 300 },
    {
      "type": "extract_regex",
      "patterns": {
        "followers": { "pattern": "(\\d+)\\s*被关注", "group": 1 }
      }
    },
    {
      "type": "transform_text",
      "transforms": [
        { "type": "normalize" },
        { "type": "replace_regex", "pattern": "\\s+广告\\s+", "replacement": " " }
      ],
      "maxChars": 3000
    }
  ],
  "headless": true,
  "autoFallbackHeadful": true,
  "traceId": "optional-trace-id",
  "timeoutMs": 15000,
  "runRetryTimes": 1,
  "actionRetryTimes": 1,
  "actionRetryDelayMs": 350,
  "autoScreenshotOnError": true,
  "errorScreenshotDir": "sessions/screens/errors",
  "viewport": { "width": 1280, "height": 720 },
  "waitUntil": "domcontentloaded",
  "userAgent": "Mozilla/5.0 ...",
  "headers": { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" },
  "blockResourceTypes": ["image", "font", "media"],
  "blockUrlRules": [{ "contains": "google-analytics.com" }],
  "storageStatePath": "sessions/jike/storage.json",
  "saveStorageStatePath": "sessions/jike/storage.json",
  "returnHtml": false
}
```

## Output
Return JSON:
- `ok`
- `traceId` (unified id for this run)
- `steps` with per-step status
- `extractedText` (if extract action used)
- `extractedItems` (if extract_all/extract_attr/extract_regex action used)
- `screenshots` (list of saved paths)
- `downloads` (list of saved download paths)
- `finalUrl`, `title` (best-effort)
- `html` (only when `returnHtml=true`)
- `mode` (`headless` or `headful`)
- `fallbackUsed` / `fallbackReason` (when auto downgrade is triggered)

## Steps
1. Launch Playwright Chromium.
2. Navigate to `url` (required).
3. Execute actions in order.
4. Collect extracts/screenshots and return a result summary.

## Guardrails
- Keep timeouts reasonable (default 15s).
- Only write files under `sessions/` or `assets/`.
- If a selector is missing, record the error but continue remaining steps.
- `storageStatePath` enables logged-in sessions; `saveStorageStatePath` persists a new session.
- Retry model:
  - Run-level: `runRetryTimes`
  - Step-level: `actionRetryTimes` (or per-action `retryTimes`)
  - Error screenshot path is auto-generated under `errorScreenshotDir`.
