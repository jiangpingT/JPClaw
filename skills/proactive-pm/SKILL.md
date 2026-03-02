# 主动产品经理 (Proactive PM)

每日以产品经理视角扫描全球产品生态，聚焦三大方向，识别 TPF 机遇，生成可执行产品 Idea。

## 三大关注域

| 域 | 内容 |
|---|---|
| 🤖 AI产品 | LLM 应用、Agent 工具、多模态产品新形态 |
| 🦾 Robot产品 | 具身智能、人形机器人、机器狗周边产品生态 |
| 💬 IM新形态 | AI 时代即时通讯新范式（异步 Agent、情境感知消息、持久 AI 人格等）|

## 核心框架：TPF（技术产品适配）

**技术成熟度 × 用户痛点强度 × 市场窗口** → A/B/C 评级

- **A**：技术已可用，痛点强烈，窗口正在打开（立即跟进）
- **B**：技术基本就绪，痛点中等，需要验证（持续关注）
- **C**：技术尚早或痛点弱，等待信号（列入观察）

## 数据来源

- **ProductHunt** — 今日上线产品（最直接的产品形态信号）
- **HackerNews** — Show HN / Launch HN（开发者自发的产品发布）
- **Reddit** — r/artificial、r/MachineLearning、r/robotics、r/SaaS、r/startups（真实用户讨论）
- **Google News + Bing News** — 按域关键词采集最新报道

## 输出格式

```
🎯 主动产品经理 | YYYY-MM-DD

🤖 AI产品
📦 新产品形态：...
💡 TPF机遇：... [评级]
🔥 用户洞察：...

🦾 Robot产品
📦 新产品形态：...
💡 TPF机遇：... [评级]
🔥 用户洞察：...

💬 IM新形态
📦 新产品形态：...
💡 TPF机遇：... [评级]
🔥 用户洞察：...

💡 今日产品 Idea（最多3条）
• Idea 1（TPF: A）— 谁用 / 做什么 / 为什么现在

📌 一句话洞察
```

## 调用参数

| 参数 | 类型 | 说明 | 默认值 |
|---|---|---|---|
| `channelId` | string | Discord 频道 ID | 1469204772379693222 |
| `telegramChatId` | string | Telegram Chat ID | - |

## 示例

```json
{
  "name": "proactive-pm",
  "input": "{\"channelId\": \"1469204772379693222\", \"telegramChatId\": \"-1003855994917\"}"
}
```

## 报告存储

`sessions/brain/pm-reports/YYYY-MM-DD-pm.md`
