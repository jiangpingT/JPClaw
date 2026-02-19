---
name: mcporter
description: MCP 服务器管理和调用工具。支持列出、配置、认证和直接调用 MCP 服务器/工具(HTTP 或 stdio)。包括临时服务器、配置编辑、CLI/类型生成等功能。适用于"调用 MCP 工具"、"MCP 配置"、"生成 MCP 客户端"等查询。基于 mcporter CLI。
homepage: http://mcporter.dev
metadata:
  {
    "openclaw":
      {
        "emoji": "📦",
        "requires": { "bins": ["mcporter"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "mcporter",
              "bins": ["mcporter"],
              "label": "Install mcporter (node)",
            },
          ],
      },
  }
---

# mcporter

Use `mcporter` to work with MCP servers directly.

This skill now has an executable entry (`index.js`) with policy guardrails.

Recommended flow:

- `{"action":"policy_init"}` to generate `sessions/mcp/policy.json`
- `{"action":"doctor"}` to check CLI/config
- `{"action":"list"}`
- `{"action":"call","selector":"<server.tool>","args":{...}}`

Quick start

- `mcporter list`
- `mcporter list <server> --schema`
- `mcporter call <server.tool> key=value`

Call tools

- Selector: `mcporter call linear.list_issues team=ENG limit:5`
- Function syntax: `mcporter call "linear.create_issue(title: \"Bug\")"`
- Full URL: `mcporter call https://api.example.com/mcp.fetch url:https://example.com`
- Stdio: `mcporter call --stdio "bun run ./server.ts" scrape url=https://example.com`
- JSON payload: `mcporter call <server.tool> --args '{"limit":5}'`

Auth + config

- OAuth: `mcporter auth <server | url> [--reset]`
- Config: `mcporter config list|get|add|remove|import|login|logout`

Daemon

- `mcporter daemon start|status|stop|restart`

Codegen

- CLI: `mcporter generate-cli --server <name>` or `--command <url>`
- Inspect: `mcporter inspect-cli <path> [--json]`
- TS: `mcporter emit-ts <server> --mode client|types`

Notes

- Config default: `./config/mcporter.json` (override with `--config`).
- Prefer `--output json` for machine-readable results.
- Policy default: `sessions/mcp/policy.json`
  - `allowStdio=false`
  - `allowRemoteUrl=false`
  - `denyServers=["filesystem","shell","terminal","exec"]`
