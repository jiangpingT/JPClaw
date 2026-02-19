---
name: food-order
description: Foodora 外卖订餐工具。使用 ordercli 重新订购 Foodora 外卖并追踪 ETA/状态。支持查看历史订单、预览重新订购、确认下单、追踪配送状态。适用于"订外卖"、"重新订购XX"、"追踪外卖"、"查看订单状态"等查询。必须显式用户确认才能下单，需要配置 Foodora 账户。
homepage: https://ordercli.sh
metadata: {"openclaw":{"emoji":"🥡","requires":{"bins":["ordercli"]},"install":[{"id":"go","kind":"go","module":"github.com/steipete/ordercli/cmd/ordercli@latest","bins":["ordercli"],"label":"Install ordercli (go)"}]}}
---

# Food order (Foodora via ordercli)

Goal: reorder a previous Foodora order safely (preview first; confirm only on explicit user “yes/confirm/place the order”).

Hard safety rules

- Never run `ordercli foodora reorder ... --confirm` unless user explicitly confirms placing the order.
- Prefer preview-only steps first; show what will happen; ask for confirmation.
- If user is unsure: stop at preview and ask questions.

Setup (once)

- Country: `ordercli foodora countries` → `ordercli foodora config set --country AT`
- Login (password): `ordercli foodora login --email you@example.com --password-stdin`
- Login (no password, preferred): `ordercli foodora session chrome --url https://www.foodora.at/ --profile "Default"`

Find what to reorder

- Recent list: `ordercli foodora history --limit 10`
- Details: `ordercli foodora history show <orderCode>`
- If needed (machine-readable): `ordercli foodora history show <orderCode> --json`

Preview reorder (no cart changes)

- `ordercli foodora reorder <orderCode>`

Place reorder (cart change; explicit confirmation required)

- Confirm first, then run: `ordercli foodora reorder <orderCode> --confirm`
- Multiple addresses? Ask user for the right `--address-id` (take from their Foodora account / prior order data) and run:
  - `ordercli foodora reorder <orderCode> --confirm --address-id <id>`

Track the order

- ETA/status (active list): `ordercli foodora orders`
- Live updates: `ordercli foodora orders --watch`
- Single order detail: `ordercli foodora order <orderCode>`

Debug / safe testing

- Use a throwaway config: `ordercli --config /tmp/ordercli.json ...`
