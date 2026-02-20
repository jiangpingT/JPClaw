# JPClaw

一个本地优先的多智能体对话平台，支持 Discord / Telegram / 飞书多渠道接入，内置 80+ 技能、混合记忆系统与 Search→Read→Answer 搜索引擎。

---

## 架构概览

```
用户消息
  │
  ├─ Discord ──────┐
  ├─ Telegram ─────┤
  └─ Feishu / HTTP ┘
                   │
              Gateway (18790)
                   │
           ┌───────┴────────┐
        Skill Router      PI Agent
       (AI意图识别)      (LLM对话)
           │                │
       技能执行          记忆系统
       (80+ skills)   (BM25+向量+图谱)
```

**多 Bot 协作模式（Discord / Telegram）**

| Bot | 角色 | 策略 |
|-----|------|------|
| expert | 正面专家，直接回答 | 必答 |
| critic | 反面质疑者，找漏洞 | AI 决策参与 |
| thinker | 深度思考者，哲学升华 | AI 决策参与 |

---

## 核心特性

- **Search → Read → Answer**：搜索后自动用 Jina.ai 抓取正文，LLM 合成直接答案，不暴露搜索过程
- **AI Skill Router**：LLM 理解用户意图，自动匹配 80+ 技能，零硬编码规则
- **多模态输入**：文本、图片、语音（Whisper STT）、视频（帧+音轨）、文档
- **混合记忆**：BM25 + Embedding 语义检索 + Knowledge Graph
- **多渠道**：Discord、Telegram、飞书、HTTP API
- **Canvas / A2UI**：实时 UI 推送渲染
- **主动技能**：定时早报、社区雷达、下午报告、代码巡检

---

## 快速开始

```bash
git clone https://github.com/jiangpingT/JPClaw.git
cd JPClaw
npm install
cp .env.example .env   # 填写必要的 API key
npm run restart        # 启动服务（端口 18790）
```

### 服务管理

```bash
npm run restart   # 重启服务
npm run status    # 查看状态
npm run logs      # 查看日志
npm run stop      # 停止服务
npm run dev -- doctor  # 本地诊断
```

---

## 配置

复制 `.env.example` 为 `.env`，按需填写：

| 变量 | 说明 | 必填 |
|------|------|------|
| `ANTHROPIC_AUTH_TOKEN` | Anthropic API Key | ✅ |
| `ANTHROPIC_BASE_URL` | 代理地址（默认 vibe.deepminer.ai） | ✅ |
| `MININGLAMP_GATEWAY_API_KEY` | 集团网关 Key（Gemini/STT/TTS） | 可选 |
| `SERPER_API_KEY` | Google 搜索 API（2500次/月免费） | 可选 |
| `DISCORD_BOT1_TOKEN` | Discord Bot Token | 可选 |
| `TELEGRAM_BOT1_TOKEN` | Telegram Bot Token | 可选 |
| `AMAP_API_KEY` | 高德地图 API | 可选 |

完整配置说明见 [CONFIGURATION.md](CONFIGURATION.md)。

---

## 技能列表（80+）

<details>
<summary>展开查看全部技能</summary>

**搜索 & 信息**
`web-search` `web-scraper` `web-screenshot` `scrape-hn-titles` `summarize` `blogwatcher`

**地图 & 本地**
`zh-map-amap` `map-query` `map-share-links` `local-places` `goplaces` `food-order`

**生产力**
`notion` `obsidian` `notes` `bear-notes` `apple-notes` `apple-reminders` `things-mac` `trello` `github` `gmail-search` `slack` `discord`

**媒体生成**
`image-gen` `video-frames` `gemini` `camsnap` `gifgrep` `songsee`

**音视频**
`audio-stt-local` `audio-tts-local` `whisper-api` `whisper-local` `tts-sherpa` `transcript-fast` `voice-call`

**开发 & 系统**
`coding-agent` `browser-automation` `api-integration` `github` `tmux` `system-analyzer` `workflow-runner` `scheduled-tasks`

**AI & 分析**
`insight-summary` `data-analysis` `social-stats` `model-usage` `survey-batch` `oracle`

**主动技能（定时触发）**
`morning-brief` `afternoon-report` `community-radar` `proactive-coder`

**文档 & 内容**
`doc-generation` `design-doc-mermaid` `slide-outline` `nano-pdf` `entity-intro` `skill-creator`

**智能家居 & 设备**
`openhue` `spotify-player` `bluetooth-cli` `eightctl` `screen-capture`

**通讯**
`imsg` `whatsapp-cli` `bluebubbles` `moltbook` `email-automation`

**系统工具**
`canvas` `clawhub` `echo` `healthcheck` `session-logs` `mcporter` `ordercli`

</details>

---

## API

Gateway 默认监听 `127.0.0.1:18790`：

```bash
# 对话
curl -X POST http://127.0.0.1:18790/chat \
  -H 'Content-Type: application/json' \
  -d '{"message": "今天天气怎么样", "userId": "u1"}'

# 执行技能
curl -X POST http://127.0.0.1:18790/skills/run \
  -H 'Content-Type: application/json' \
  -d '{"skill": "web-search", "input": "YC 最新赛道"}'

# Canvas 推送
curl -X POST http://127.0.0.1:18790/canvas/push \
  -H 'Content-Type: application/json' \
  -d '{"type":"html","html":"<div>Hello</div>"}'

# 健康检查
curl http://127.0.0.1:18790/health
```

---

## 技术栈

| 层 | 技术 |
|----|------|
| Runtime | Node.js 22+ (ESM) |
| Language | TypeScript 5.5+ |
| AI 主力 | Anthropic Claude (vibe.deepminer.ai) |
| AI 网关 | 明略科技 LLM Guard (Gemini/DeepSeek) |
| 搜索 | Serper.dev + DuckDuckGo + Jina.ai Reader |
| 向量 | 自研向量存储 + BM25 (SQLite) |
| STT | Whisper (集团网关) |
| 渠道 | Discord.js + node-telegram-bot-api + 飞书 |

---

## 文档

- [ARCHITECTURE.md](ARCHITECTURE.md) — 系统架构详解
- [CHANGELOG.md](CHANGELOG.md) — 版本更新历史
- [docs/adr/](docs/adr/) — 架构决策记录
- [.env.example](.env.example) — 完整配置示例

---

## License

MIT
