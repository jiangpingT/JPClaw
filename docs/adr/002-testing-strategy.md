# ADR-002: 测试策略与管理规范

## 状态
已采纳

## 日期
2026-02-18

## 背景

项目测试管理存在以下问题：
1. **框架混用** — 同时使用 Vitest（tests/unit/）和 Node.js test（tests/js/），无统一标准
2. **覆盖率极低** — 116个源文件仅11个有测试（9.5%），远低于70%目标
3. **目录结构不规范** — tests/unit/、tests/js/、tests/ 根目录三处存放测试，不镜像源码结构
4. **无策略文档** — 没有"哪些模块必须测试""测试如何分层"的决策记录
5. **文档与代码混放** — tests/ 下堆了20个 md 文件

## 决策

### 1. 统一测试框架：Vitest

所有测试统一使用 Vitest 框架。不再使用 `node:test` + `node:assert`。

**理由**：
- 项目已依赖 Vitest，IDE 支持好
- 提供 `describe/it/expect` 语法，可读性强
- 内置 mock、覆盖率、watch 模式
- TypeScript 原生支持

### 2. 测试分层策略

```
tests/
├── unit/           # 单元测试：隔离测试单个函数/类，使用 mock
├── integration/    # 集成测试：多模块协作，可使用真实依赖
├── e2e/            # 端到端测试：模拟完整用户流程
└── fixtures/       # 共享测试数据和工具
```

**命名规范**：
- 文件名：`{模块名}.test.ts`（统一用 `.test.ts`，不用 `.spec.ts`）
- 目录结构：镜像 `src/js/` 的目录结构
- 测试用例：`should + 动词 + 预期行为`（英文）

**示例**：
```
src/js/memory/vector-store.ts       → tests/unit/memory/vector-store.test.ts
src/js/providers/anthropic.ts       → tests/unit/providers/anthropic.test.ts
src/js/gateway/index.ts             → tests/integration/gateway/api.test.ts
```

### 3. 测试优先级（哪些模块必须有测试）

**P0 — 必须有单元测试（核心业务逻辑）**：
| 模块 | 源文件 | 理由 |
|------|--------|------|
| memory/vector-store.ts | 1122行 | 核心数据存储 |
| memory/enhanced-memory-manager.ts | 1218行 | 核心业务逻辑 |
| memory/conflict-resolver.ts | 909行 | 数据一致性保障 |
| pi/engine.ts | 1346行 | 核心对话引擎 |
| shared/async-utils.ts | 179行 | 基础设施 |
| shared/security-utils.ts | 279行 | 安全防护 |

**P1 — 应该有单元测试（重要功能）**：
| 模块 | 源文件 | 理由 |
|------|--------|------|
| providers/anthropic.ts | API集成 | 外部依赖需要mock测试 |
| providers/openai.ts | API集成 | 外部依赖需要mock测试 |
| llm/gateway-client.ts | LLM网关 | 超时/重试逻辑 |
| memory/embedding-service.ts | 向量化 | 缓存/降级逻辑 |
| security/middleware.ts | 安全中间件 | 速率限制/CORS |
| shared/validation.ts | 输入验证 | 边界条件 |

**P2 — 应有集成测试（系统集成）**：
| 模块 | 理由 |
|------|------|
| gateway/index.ts | API 端点完整性 |
| channels/discord-bot-handler.ts | 消息处理流程 |
| memory/ 整体 | 记忆查询→更新→冲突解决流程 |

### 4. Mock 管理规范

```
tests/fixtures/
├── mocks/              # 共享 mock 实现
│   ├── providers.ts    # AI Provider mock
│   ├── memory.ts       # 记忆系统 mock
│   └── discord.ts      # Discord.js mock
├── data/               # 测试数据
│   └── sample-vectors.json
└── helpers.ts          # 通用测试工具函数
```

**Mock 原则**：
- 单元测试：所有外部依赖必须 mock
- 集成测试：允许真实依赖，但外部API必须 mock
- mock 文件集中在 `fixtures/mocks/`，不在测试文件中内联定义

### 5. 覆盖率目标

| 阶段 | 目标 | 期限 |
|------|------|------|
| 当前 | ~10% | — |
| 近期 | 40%（P0模块100%） | 1个月 |
| 中期 | 60%（P0+P1模块100%） | 3个月 |
| 长期 | 70%+ | 持续 |

### 6. CI/CD 集成

- `npm test` — 运行全部测试
- `npm run test:unit` — 只运行单元测试（CI 必过）
- `npm run test:coverage` — 生成覆盖率报告
- PR 合入条件：单元测试全部通过 + 覆盖率不低于当前值

## 考虑的方案

### 方案A：继续混用 Vitest + Node.js test
**优点**：无迁移成本
**缺点**：规范混乱，新人无所适从

### 方案B：全部统一为 Vitest（已采纳）
**优点**：统一规范、IDE支持好、功能完整
**缺点**：需要迁移现有17个 spec 文件

### 方案C：迁移到 Jest
**优点**：社区生态最大
**缺点**：ESM 支持差，与 Vitest 功能重叠，需要额外配置

## 后果

### 积极影响
- 新开发者立即知道"测试该怎么写、放哪里"
- 覆盖率可量化追踪
- CI 能可靠守护代码质量

### 消极影响
- 需要一次性迁移17个 spec 文件的工作量

### 风险
- 迁移过程中可能引入测试逻辑变化

## 实现细节

**配置文件**：`vitest.config.ts`（已存在）

**测试脚本**（package.json）：
```json
{
  "test": "vitest",
  "test:unit": "vitest run tests/unit/",
  "test:integration": "vitest run tests/integration/",
  "test:coverage": "vitest run --coverage"
}
```

**标准测试模板**：
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('模块名', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('方法名', () => {
    it('should 做什么', () => {
      // Arrange
      // Act
      // Assert
      expect(result).toBe(expected);
    });
  });
});
```

## 相关文档
- [ADR-001: 多Agent协作](001-multi-agent-collaboration.md)
- [Vitest 配置](../../vitest.config.ts)

## 参与者
- Claude Code (阿策) - 提议者
- 姜平 - 审核者
