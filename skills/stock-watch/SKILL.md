---
name: stock-watch
description: 收盘行情播报。每日追踪指定港股/美股的当日成交额，所有金额统一换算成港币，由 AI 生成简洁播报推送到 Telegram/Discord。默认自选股：MiniMax(0100.HK)、智谱AI(2513.HK)、AppLovin(APP)、Palantir(PLTR)、商汤科技(0020.HK)、明略科技(2718.HK)。
---

# Stock Watch Skill

## Input

JSON 字段：
- `watchlist`（可选）：自定义股票列表，格式 `[{name, ticker, market}]`
- `channelId`（可选）：Discord 频道 ID
- `telegramChatId`（可选）：Telegram 群组 ID

## Output

JSON：
- `ok`：是否成功
- `date`：报告日期
- `usdHkd`：当日 USD/HKD 汇率
- `stocks`：追踪只数
- `reportPath`：本地保存路径
- `discordMessageIds` / `telegramMessageIds`：推送结果
