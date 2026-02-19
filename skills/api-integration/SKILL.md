---
name: api-integration
description: HTTP 请求工具。通用的 HTTP 客户端，用于调用内部 API 集成。支持 GET/POST/PUT/DELETE 等方法、自定义请求头、认证、JSON/原始请求体、超时控制。适用于"调用XX API"、"发送HTTP请求"、"测试接口"、"查询API"等场景。返回状态码、响应头、响应体（截断到5000字符）。
---

# Api Integration

# API Integration

## Purpose
Call a single HTTP endpoint and return a concise response summary.

## Input
Accept plain text or JSON. If plain text, treat it as `url`.

JSON fields:
- `method`: HTTP method (default: GET)
- `url` or `endpoint`: target URL (required)
- `headers`: object of headers
- `auth`: value for `Authorization` header
- `body`: object to JSON-encode
- `rawBody`: raw body string (used if `body` is not provided)
- `timeoutMs`: request timeout in milliseconds (default: 8000)

## Output
Return JSON:
- `ok`, `status`, `headers`, `body` (truncate body to ~5000 chars)

## Guidance
- If the request fails, return `request_failed: <error>`.
- Keep output JSON pretty-printed.
