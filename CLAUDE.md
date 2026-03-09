# JPClaw 项目指令

## 身份
- 用户称呼：姜哥
- 我的昵称：阿策
- 默认语言：中文

## 核心工程原则

### 永远不要硬编码
- 默认泛化实现，优先考虑通用、可扩展的架构
- 硬编码是最后手段，必须姜哥明确确认
- 检查清单：能否通过配置实现？能否让 AI 判断？能否设计通用机制？

### AI 驱动
- 让 AI 理解和决策，而不是硬编码规则
- 给 AI 足够的上下文，让它做对的决定

### 从根本解决问题
- 治本不治标，找到本质原因

### 主动扩充工具链
- 如果判断「有了 X 工具能做得更好、更可验证」，明确告诉姜哥并建议安装，不要悄悄降级处理凑合过去
- 工具链的主动扩充是工作质量的一部分

## 服务管理
- **重启服务**：`npm run restart`（禁止手动 node/pkill）
- **查看状态**：`npm run status`
- **查看日志**：`npm run logs`
- **网关端口**：18790（固定，不要改）

## 测试规范
- **框架**：统一 Vitest（禁止 `node:test`）
- **文件命名**：`{模块名}.test.ts`（不用 `.spec.ts`）
- **目录**：`tests/unit/` 镜像 `src/js/` 结构
- **Mock**：共享 mock 放 `tests/fixtures/mocks/`
- **详细规范**：`docs/adr/002-testing-strategy.md`

## 代码质量
- 代码 Review 对标世界级标准（Linux Kernel, Redis 级别）
- 问题分级：P0（立即修复）→ P1（本周）→ P2（本月）→ P3（长期）
- TypeScript 严格模式，减少 `as any` 使用

## 语言规范
- 描述性文本默认中文（tool description、skill description、system prompt、注释）
- 代码标识符用英文（变量名、函数名、类名）
- 技术术语可混用英文（API、LLM、token 等）

## 文档管理
- 根目录只保留核心文件：README.md、ARCHITECTURE.md、CHANGELOG.md、CONFIGURATION.md、mission.md
- 报告/指南/设计文档归档到 `docs/` 子目录
- 测试文档放 `docs/reports/tests/`，不放 `tests/`
- 架构决策记录到 `docs/adr/`

## API 约束
- 禁止直连 OpenAI API（没有额度）
- 禁止直连 Gemini API（没有配额）
- 可用：Anthropic API（vibe.deepminer.ai 代理）、公司多模态网关（llm-guard.mininglamp.com）

## 文档更新规范

### 触发词
- "完成了"、"搞定了" → 检查 CHANGELOG
- "我们决定"、"选择方案X" → 检查 ADR
- "新增XX渠道"、"新模块" → 检查 ARCHITECTURE

### 阿策的职责
- 主动检测变更 → 主动提醒 → 确认后执行
- CHANGELOG.md — 功能完成后主动询问
- ADR — 架构决策时提醒起草
- ARCHITECTURE.md — 重大变更或每月一次

---

## 工程经验积累

### 工程原则经典案例

**方案C：AI 判断前刷新历史（治本 vs 治标）**
- 问题：Bot2 看不到 Bot1 回复
- ❌ 治标：增加 Bot2 延迟到 15 秒
- ✅ 治本：AI 判断前刷新对话历史，100% 可靠
- 启示：永远找根因，不靠猜

**多智能体协作参考实现（评分 10/10）**
- 完全 AI 驱动、零硬编码
- 角色配置：`src/js/channels/bot-roles.ts`
- 消息处理：`src/js/channels/discord-bot-handler.ts`
- ADR：`docs/adr/001-multi-agent-collaboration.md`

### 架构反思：Skill-Router 应是"工具层"而非"回复层"

**核心洞见（2026-03-05）**

skill-router 原始设计是 pre-LLM short-circuit：工具结果直接返回给用户，完全绕过 LLM。
对纯数据查询（"查天气"）没问题，但对需要判断的问题（"适合打篮球吗"）是根本性缺陷。

```
工具 → 数据  ─┐
               ├→ LLM 综合 → 最终答案   ← 正确姿势
用户问题 ────┘

工具 → 数据 → 直接返回给用户            ← 错误姿势（原设计）
```

工具是原材料，LLM 才是思考者。这才是标准的 RAG + Tool use 正确姿势。

**修复位置**：`src/js/pi/engine.ts` 第 236 行附近
- `skillRouted` 不再直接 `recordDeterministicReply`
- 改为追加综合指令进入 `enqueuePrompt → agent.prompt()`，让 LLM 基于工具数据给出结论性回答
- 适用于所有 skill（天气/股票/搜索/...），出错时 fallback 返回原始 skill 输出

### DMWork 渠道接入（2026-03-05 完成）

**架构**
- 核心：`src/js/channels/wukongim-client.ts` — 原生 WebSocket 实现 WuKongIM 协议，每个实例独立连接
- Handler：`src/js/channels/dmwork-bot-handler.ts` — 消息处理逻辑
- 入口：`src/js/channels/dmwork.ts` — 支持单 bot / 多 bot 数组
- 三个 Bot：jpexpert / jpcritic / jpthinker（.env 用 `DMWORK_BOT1_/BOT2_/BOT3_` 格式）

**血泪教训**
1. `wukongimjssdk` 是全局单例 → 多 bot 只有最后一个真正在线 → 必须用原生 WS 实现
2. **WuKongIM reasonCode=1 = 成功**（不是 MQTT 的 0=成功，逆向！）
3. SDK 默认 `protoVersion=5`（不是 4）
4. tsx `--import` 模式下命名导入运行时不可用，需通过 default 对象解构
5. WuKongIM 协议需要 DH 密钥交换（curve25519-js）+ AES-128-CBC（crypto-js）+ MD5（md5-typescript）

**已确认的群组 channel_id**
- MyBotGroup = `c41d79c8ee2b407b852a8bef1929b338`（proactive 推送目标）
- 明略幼儿园 = `fb70febf8a764b6fada47bb4632b5551`（曾误认为是 MyBotGroup）

### Bot 参与策略（2026-03-05 定型）

**当前延迟配置**（`DEFAULT_ROLES` in `bot-roles.ts`）
- expert：ai_decide，3000ms（只自动参与明略科技相关）
- critic：ai_decide，25000ms
- thinker：ai_decide，40000ms

**三条核心规则（三平台统一）**
1. @别人过滤：消息有 @mention 但没有 @本 bot → 直接跳过（无 LLM 调用）
2. @mention 必答：被直接 @本 bot → 强制响应，绕过 ai_decide
3. 链式沉默：expert 不回答 → critic/thinker 因"expert 未发言"规则也沉默

**踩坑：DMWork agentId 未设导致角色配置全走 expert**
- 根因：`.env` 漏了 `DMWORK_BOT*_AGENT`，`config.agentId ?? "expert"` fallback 到 expert → 所有 bot 都 `alwaysRespondToOwner`
- 教训：Telegram/Discord 都有 `*_AGENT` 字段，DMWork 加 bot 时必须同步加

**踩坑：Discord 持久化延迟缓存**
- 文件：`sessions/bot-roles.json`
- 问题：重启读缓存，无视 `DEFAULT_ROLES` 变更
- 修复：条件改为 `ai_decide && delay === 0`
- 教训：改 bot-roles.ts 对 Discord 无效，先检查 sessions/bot-roles.json

**踩坑：Telegram botUsername 初始化陷阱**
- `getMe()` 是异步的，启动后 `this.botUsername` 短暂为 null
- @别人过滤必须 fail-open（botUsername 为 null 时跳过过滤，不丢 @mention 消息）

### 群聊同事模型升级（2026-03-06）

**背景：任务模型 vs 同事模型**

原来是「任务模型」：每个发言人持有独立 session，LLM 生成回复时看不到群里其他人说了什么。
升级为「同事模型」：频道级 session，所有参与者共享一条时间线，bot 能感知彼此的发言。

```
任务模型（旧）：
  userA → sessionA → LLM → 回复A
  userB → sessionB → LLM → 回复B    ← bot 不知道 A 说了什么

同事模型（新）：
  group:{channelID} → 共享 session → LLM → 回复  ← bot 知道所有人说了什么
```

**三处改动（2026-03-06 实施）**

| 文件 | 改动 | 效果 |
|------|------|------|
| `dmwork-bot-handler.ts` `replyToGroup()` | userId 从 `msg.fromUID` 改为 `group:{channelID}`；注入最近 8 条历史 + `[uid]: question` 格式 | 频道级共享 session |
| `engine.ts` `reply()` | 检测 `userId.startsWith("group:")` 后注入"群组频道模式"系统提示（防重复） | LLM 知道自己在群聊，能 @发言人 |
| `engine.ts` `summarizeMessages()` | 检测 `[.+]:` 正则，选择保留发言人归属的摘要 prompt | 超 80 条压缩后仍知道谁说了什么 |
| `bot-roles.ts` | 三个角色 decisionPrompt 末尾追加 @-mention 使用规范 | LLM 自主判断何时 @，不硬编码 |

**关键设计决策：不硬编码的保证**
- session key 以 `group:{channelID}` 为 userId，任何群被拉入自动生效，无需预配置
- critic 延迟 25s 后调用 `replyToGroup`，此时 groupHistory 已有 expert 回复，自然感知
- 群聊摘要用正则 `/\[.+?\][:：]/` 检测格式，不依赖 channelId 传递

**验证方法**：日志 `pi.agent.created.sessionKey` 应含 `user:group:{channelID}|...`（不再是 `user:{fromUID}|...`）

---

### Skill Router 参数提取缺失 bug（2026-03-06）

**根因**

`skill-router.ts` 的 `maybeRunSkillFirstV2()` 在选中 skill 后，把原始用户输入（`raw`）直接传给 `runSkill()`：

```typescript
const output = await runSkill(selected.name, raw);  // ❌ raw = "今天上海的天气怎么样"
```

weather skill 的 `run()` 内：
```javascript
let params = {};
try { params = JSON.parse(input); } catch { params = {}; }  // JSON.parse 失败
const city = params.city || HOME_CITY;  // fallback 北京
```

结果：问上海天气，返回北京数据。根因是 **router 是参数提取的责任方**，但它完全没做这件事。

**修复（治本）**

1. `IntentDecision` 新增 `skillInput?: string` 字段
2. `IntentSystem.decide()` 的 prompt 让 LLM 同时提取参数：
   - "今天上海的天气" → `skillInput: {"city": "上海"}`
   - "查苹果股价" → `skillInput: {"query": "苹果 AAPL 股价"}`
3. router 调用时：`runSkill(name, decision.skillInput ?? raw)`

**教训**

- **任何 skill 都期待结构化 JSON 输入**，但用户说的是自然语言。router 是两者之间的翻译层，必须承担参数提取责任
- 这类 bug 的特征：功能"运行了"（无报错），但结果是默认值。排查方向：检查 fallback 路径是否被默默触发
- 日志里加 `skillInput` 字段是必要的，否则根本无法判断参数有没有提取到

**排查诊断流程**（下次遇到 skill 返回错误默认值时）：
1. 看日志 `skill_router.selected.skillInput` — 是否提取到了正确参数？
2. 看 weather skill 的 `city` 变量 — 走的哪个 fallback？
3. 看 `intent_system.decision.invalid_json` — LLM 返回格式是否正确？

---

### 代码量统计规范

**必须排除的目录**：`node_modules/`、`.venv/`、`.venv-doc/`、`venv/`、`.git/`、`dist/`、`build/`、`.next/`

```bash
find <项目路径> -name "*.<ext>" \
  ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/dist/*" \
  ! -path "*/build/*" ! -path "*/.next/*" \
  ! -path "*/.venv/*" ! -path "*/.venv-doc/*" ! -path "*/venv/*" \
  | xargs wc -l
```

**踩过的坑**
- JPClaw 有 `.venv`（505 文件）和 `.venv-doc`（411 文件），不排除会虚报 33 万行 Python
- JPFusion（原 fusion-platform）有 `venv/`（10,693 文件），不排除会虚报 25 万行

**各项目有效代码量（2026-03-01 统计）**

| 项目 | TS | JS | Python | 合计 |
|------|----|----|--------|------|
| JPClaw | 45,724行 | 13,350行 | 958行 | ~6万行 |
| JPRobot | — | — | 15,527行 | ~1.6万行 |
| JPFusion | 223行 | — | 8,114行 | ~1.1万行 |
