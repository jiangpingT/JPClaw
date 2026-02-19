# JPClaw

Local-first agent platform with CLI, gateway, channels (Discord/Feishu), skills, Canvas/A2UI, and voice wake.

## 📚 文档导航

- **[ARCHITECTURE.md](ARCHITECTURE.md)** - 系统架构总览
- **[CHANGELOG.md](CHANGELOG.md)** - 版本更新历史
- **[docs/adr/](docs/adr/)** - 架构决策记录（ADR）
  - [ADR-001: 多智能体协作系统](docs/adr/001-multi-agent-collaboration.md) ⭐
- **技术文档**：
  - [Skill 路由详解](docs/SKILL_ROUTING_EXPLAINED.md)
  - [Description 编写指南](docs/DESCRIPTION_WRITING_GUIDE.md)
  - [记忆生命周期](docs/memory-lifecycle.md)
  - [知识图谱](docs/knowledge-graph.md)

## Quick start (dev)

```bash
npm install
npm run dev -- init
npm run dev -- gateway
npm run dev -- doctor
```

The gateway exposes a minimal POST /chat endpoint on 127.0.0.1:18790.
Feishu webhook is available at POST /webhook/feishu (used for local dev event callbacks).
Discord channel can be enabled via `DISCORD_BOT_TOKEN`.
`doctor` runs local diagnostics for admin/token/provider/health/launchd checks.

## Canvas Host (local)

The gateway accepts canvas updates at:

```bash
curl -s -X POST http://127.0.0.1:18790/canvas/push \\
  -H 'content-type: application/json' \\
  -d '{"type":"html","html":"<div style=\\"color:#fff\\">Hello Canvas</div>"}'
```

## Voice Wake (local)

Requires Porcupine access key:

```bash
export VOICE_WAKE_ENABLED=true
export PORCUPINE_ACCESS_KEY=your_key
```

## Config

Config is read from `JPCLAW_CONFIG` or `sessions/jpclaw.json`.
Providers can be configured via env (e.g. `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`), and require a model name (e.g. `ANTHROPIC_MODEL`, `OPENAI_MODEL`).

## 🚀 常用命令

```bash
# 重启服务（推荐）
npm run restart

# 查看服务状态
npm run status

# 查看日志
npm run logs

# 停止服务
npm run stop

# 诊断工具
npm run dev -- doctor
```

## 🌟 核心特性

- **多智能体协作**：Discord 多 Bot 协作，AI 驱动，零硬编码（[详见 ADR-001](docs/adr/001-multi-agent-collaboration.md)）
- **AI Router**：技能路由完全由 AI 理解 description 决定，无需硬编码规则
- **混合记忆**：BM25 + Embedding + Knowledge Graph
- **多渠道支持**：Discord、Telegram、Feishu
- **Canvas & A2UI**：实时 UI 渲染
- **Voice Wake**：语音唤醒（Porcupine）

## 📖 更多文档

详细架构和设计决策请参考：
- [系统架构](ARCHITECTURE.md)
- [架构决策记录](docs/adr/)
