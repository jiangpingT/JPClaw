# JPClaw 测试系统

> 测试策略详见 [ADR-002: 测试策略与管理规范](../docs/adr/002-testing-strategy.md)

## 目录结构

```
tests/
├── unit/              # 单元测试（隔离测试，使用 mock）
│   ├── memory/        # 记忆系统
│   ├── shared/        # 共享工具
│   ├── channels/      # 渠道处理
│   ├── agents/        # Agent 管理
│   ├── skills/        # 技能系统
│   └── pi/            # PI 引擎
├── integration/       # 集成测试（多模块协作）
├── e2e/               # 端到端测试
├── fixtures/          # 共享测试工具
│   ├── mocks/         # Mock 实现
│   ├── data/          # 测试数据
│   └── helpers.ts     # 通用工具函数
├── setup.ts           # Vitest 环境配置
└── README.md          # 本文件
```

## 运行测试

```bash
npm test                    # watch 模式
npm run test:unit           # 运行全部测试（单次）
npm run test:coverage       # 覆盖率报告
npx vitest run tests/unit/memory/   # 只运行记忆模块测试
```

## 编写测试规范

**框架**：Vitest（统一标准，不再使用 `node:test`）

**文件命名**：`{模块名}.test.ts`

**目录**：镜像 `src/js/` 结构
- `src/js/memory/vector-store.ts` → `tests/unit/memory/vector-store.test.ts`
- `src/js/channels/reply-guard.ts` → `tests/unit/channels/reply-guard.test.ts`

**测试模板**：
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MyModule } from '../../../src/js/path/my-module.js';

describe('MyModule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('methodName', () => {
    it('should do expected behavior', () => {
      // Arrange
      const input = 'test';
      // Act
      const result = MyModule.method(input);
      // Assert
      expect(result).toBe('expected');
    });
  });
});
```

**Mock 规范**：
- 单元测试：所有外部依赖必须 mock
- 共享 mock 放在 `fixtures/mocks/`
- 工具函数放在 `fixtures/helpers.ts`

## 技能路由测试（E2E）

```bash
# 单个查询
node dist/cli/index.js chat "搜索一下今天的科技新闻"

# 批量测试 80 个技能
node dist/cli/index.js test-routing

# 快速测试
cd tests && ./run-routing-test.sh quick
```

测试数据：`tests/skill-routing-tests.json`

## 测试优先级

| 级别 | 模块 | 状态 |
|------|------|------|
| P0 | memory/vector-store | ✅ 已有 |
| P0 | memory/enhanced-memory-manager | 待补充 |
| P0 | memory/conflict-resolver | 待补充 |
| P0 | pi/engine | 待补充 |
| P0 | shared/async-utils | 待补充 |
| P0 | shared/security-utils | 待补充 |
| P1 | providers/anthropic | 待补充 |
| P1 | providers/openai | 待补充 |
| P1 | security/middleware | 待补充 |
