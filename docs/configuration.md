# Configuration

JPClaw reads configuration from `JPCLAW_CONFIG` or `sessions/jpclaw.json`.
At least one provider must be configured with a model name (e.g. `OPENAI_MODEL` or `ANTHROPIC_MODEL`).

Skills are discovered from `skills/` by default (see `src/js/skills/README.md`).

Environment variables:
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_AUTH_HEADER`
- `OPENAI_AUTH_SCHEME`
- `OPENAI_MODEL`
- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_HEADER`
- `ANTHROPIC_AUTH_SCHEME`
- `ANTHROPIC_MODEL`
- `ANTHROPIC_VERSION`
- `ANTHROPIC_ALWAYS_THINKING`
Engine routing is Pi-only (AgentCore has been removed).
- `JPCLAW_PI_PROVIDER` (e.g. `openai`, `anthropic`)
- `JPCLAW_PI_MODEL` (e.g. `gpt-4.1-mini`, `claude-3-5-sonnet-20240620`)
- `JPCLAW_PI_THINKING_LEVEL` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`)
- `JPCLAW_PI_MAX_MESSAGES` (auto summary threshold, default `80`)
- `JPCLAW_PI_KEEP_MESSAGES` (messages kept after summary, default `30`)
- `JPCLAW_PI_SUMMARY_MAX_CHARS` (summary input cap, default `6000`)
- `DISCORD_BOT_TOKEN`
- `DISCORD_ADMIN_IDS`
- `DISCORD_FAST_ACK_MS`
- `DISCORD_WORK_TIMEOUT_MS`
- `DISCORD_REPLY_MODE` (default `mention_or_dm`; `all` to reply in all channels; `mention` to require @bot; `mention_or_dm` to reply only in DMs or when addressed)
- `DISCORD_ALLOWED_CHANNEL_IDS` (comma-separated channel IDs that JPClaw will reply in without @bot)
- `JPCLAW_ADMIN_TOKEN` (optional; required for `/admin/*` HTTP APIs when set)
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_VERIFICATION_TOKEN`
- `FEISHU_ENCRYPT_KEY`
- `FEISHU_WORK_TIMEOUT_MS` (passive reply timeout, default `4500`)
- `FEISHU_FINAL_TIMEOUT_MS` (max time to wait for final reply, default `45000`)
- `FEISHU_DEDUPE_WINDOW_MS` (event dedupe window, default `300000`)
- `FEISHU_FORCE_DIRECT_STYLE` (force concise direct replies, default `true`)
- `WECOM_ENABLED`
- `WECOM_CORP_ID`
- `WECOM_AGENT_ID`
- `WECOM_APP_SECRET`
- `WECOM_TOKEN`
- `WECOM_ENCODING_AES_KEY`
- `WECOM_CALLBACK_DOMAIN`
- `WECOM_WORK_TIMEOUT_MS` (passive reply timeout, default `4500`)
- `WECOM_FINAL_TIMEOUT_MS` (max time to wait for final reply, default `45000`)
- `WECOM_DEDUPE_WINDOW_MS` (message dedupe window, default `300000`)
- `WECOM_FORCE_DIRECT_STYLE` (force concise direct replies, default `true`)
- `JPCLAW_LOG_LEVEL`
- `JPCLAW_CANVAS_URL`
- `BRAVE_SEARCH_API_KEY` (optional, enables Brave provider in `skills/web-search`)
- `JPCLAW_NO_PROXY` (comma-separated host list for proxy bypass, e.g. `qyapi.weixin.qq.com`)
- `JPCLAW_REPLY_CACHE_MS`
- `VOICE_WAKE_ENABLED`
- `VOICE_WAKE_KEYWORD`
- `PORCUPINE_ACCESS_KEY`


Discord ops mode:
- Set `DISCORD_ADMIN_IDS` (comma-separated user IDs).
- Admins can run `/ops exec <command>` and `/ops restart` from Discord.
- Dangerous operations always require `/ops confirm <token>` before execution.

Discord multi-agent admin:
- `/agent list`
- `/agent create <agentId> [name]`
- `/agent bind <agentId> [channelId]`
- `/agent unbind [channelId]`
- `/agent delete <agentId>`
- Note: these commands require the sender to be in `DISCORD_ADMIN_IDS`.

HTTP admin APIs:
- `GET /admin/agents`
- `POST /admin/agents` body `{ "id": "jpclaw1", "name": "JPClaw 1" }`
- `GET /admin/bindings`
- `POST /admin/bindings` body `{ "channelId": "1234567890", "agentId": "jpclaw1" }`
- `DELETE /admin/bindings?channelId=1234567890`
- `DELETE /admin/agents?agentId=jpclaw1`
- When `JPCLAW_ADMIN_TOKEN` is set, pass `Authorization: Bearer <token>` or `x-admin-token: <token>`.

WeCom webhook:
- Callback URL: `GET/POST /webhook/wecom`
- `GET` is used for URL verification (`echostr` validation).
- `POST` receives message callbacks and forwards text content into JPClaw agent replies.

WeCom health check:
- `GET /wecom/ping?toUser=<userid>&text=<message>`
- `GET /wecom/ping?chatId=<chatId>&text=<message>`

Feishu webhook:
- Callback URL: `POST /webhook/feishu`
- URL verification (`challenge`) is supported.
- Event subscription `im.message.receive_v1` is supported for text messages.

Feishu health check:
- `GET /feishu/ping?chatId=<chatId>&text=<message>`

Pi sessions:
- Session snapshots: `sessions/pi/users/s_<hash>.json`
- Transcripts (append-only): `sessions/pi/transcripts/t_<hash>.jsonl`
- Session index: `sessions/pi/sessions.json`

Pi branching:
- Use `/branch <name>` to switch or create a branch.
- Use `/branch` to view current branch and available branches.

Pi skills:
- Use `/skill <name> [description] [--overwrite]` to create a skill template.
- Repetitive tasks trigger auto skill template creation.

New executable skills:
- `web-search`: structured web retrieval (`provider=auto|brave|builtin`)
- `transcript-fast`: YouTube transcript extraction with timestamp segments
- `design-doc-mermaid`: requirement-to-design-doc + Mermaid generation
- `mcporter`: MCP wrapper with policy guardrails (`sessions/mcp/policy.json`)
