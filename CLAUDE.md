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

## 文档更新触发词
- "完成了"、"搞定了" → 检查 CHANGELOG
- "我们决定"、"选择方案X" → 检查 ADR
- "新增XX渠道"、"新模块" → 检查 ARCHITECTURE
