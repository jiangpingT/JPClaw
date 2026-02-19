# JPClaw 文档架构

> **文档是项目的记忆系统** - 像管理代码一样管理文档

---

## 📚 文档层次架构

```
JPClaw/
├── README.md                           # 项目入口（快速开始）
├── DOCUMENTATION.md                    # 本文件（文档索引总览）
├── ARCHITECTURE.md                     # 系统架构（技术全景）
├── CONFIGURATION.md                    # 配置指南（环境搭建）
├── CHANGELOG.md                        # 版本历史（变更记录）
│
├── docs/                               # 📁 文档中心
│   ├── README.md                       # 文档中心索引
│   ├── adr/                            # 🏛️ 架构决策记录（ADR）
│   │   ├── README.md                   # ADR 索引和规范
│   │   ├── template.md                 # ADR 模板
│   │   └── 001-*.md                    # 具体的 ADR
│   │
│   ├── reports/                        # 📊 工作报告归档
│   │   ├── README.md                   # 报告索引和规范
│   │   ├── reviews/                    # 代码审查报告
│   │   ├── daily/                      # 每日工作总结
│   │   ├── phases/                     # 阶段性报告
│   │   ├── fixes/                      # 修复总结
│   │   └── optimizations/              # 优化报告
│   │
│   ├── guides/                         # 📖 使用指南
│   │   ├── quickstart/                 # 快速开始
│   │   ├── development/                # 开发指南
│   │   ├── deployment/                 # 部署指南
│   │   └── troubleshooting/            # 故障排查
│   │
│   ├── api/                            # 🔌 API 文档
│   │   ├── http/                       # HTTP API
│   │   ├── websocket/                  # WebSocket API
│   │   └── internal/                   # 内部 API
│   │
│   └── specifications/                 # 📐 技术规范
│       ├── memory-system.md            # 记忆系统规范
│       ├── skill-system.md             # 技能系统规范
│       ├── security.md                 # 安全规范
│       └── coding-standards.md         # 编码规范
│
└── scripts/                            # 🔧 文档工具
    └── docs/                           # 文档管理脚本
        ├── archive-report.sh           # 归档报告
        ├── generate-index.sh           # 生成索引
        └── check-links.sh              # 检查链接
```

---

## 🎯 文档分类体系

### 1. 入口级文档（Entry Level）

**目标受众**：新用户、新开发者
**位置**：项目根目录
**特点**：简洁、快速上手

| 文件 | 用途 | 优先级 |
|------|------|--------|
| `README.md` | 项目简介、快速开始 | ⭐⭐⭐ |
| `QUICK_REFERENCE.md` | 快速参考手册 | ⭐⭐ |
| `RESTART_GUIDE.md` | 重启指南 | ⭐⭐ |

### 2. 架构级文档（Architecture Level）

**目标受众**：架构师、核心开发者
**位置**：项目根目录 + `docs/adr/`
**特点**：深度、全面、决策记录

| 文件 | 用途 | 优先级 |
|------|------|--------|
| `ARCHITECTURE.md` | 系统架构总览 | ⭐⭐⭐ |
| `CONFIGURATION.md` | 配置架构 | ⭐⭐⭐ |
| `docs/adr/*.md` | 架构决策记录 | ⭐⭐⭐ |

### 3. 功能级文档（Feature Level）

**目标受众**：功能开发者、集成者
**位置**：`docs/` 各子目录
**特点**：详细、操作性强

| 目录 | 用途 | 示例 |
|------|------|------|
| `docs/guides/` | 操作指南 | Discord 集成指南 |
| `docs/api/` | API 文档 | HTTP API 规范 |
| `docs/specifications/` | 技术规范 | 记忆系统规范 |

### 4. 过程级文档（Process Level）

**目标受众**：项目管理者、代码审查者
**位置**：`docs/reports/`
**特点**：时间序列、可追溯

| 子目录 | 用途 | 保留时间 |
|--------|------|----------|
| `reviews/` | 代码审查报告 | 永久 |
| `daily/` | 每日工作总结 | 3个月 |
| `phases/` | 阶段性报告 | 永久 |
| `fixes/` | 修复总结 | 6个月 |
| `optimizations/` | 优化报告 | 6个月 |

### 5. 历史级文档（Historical Level）

**目标受众**：全体成员
**位置**：项目根目录
**特点**：版本化、结构化

| 文件 | 用途 | 更新频率 |
|------|------|----------|
| `CHANGELOG.md` | 版本变更历史 | 每次发布 |
| `MEMORY.md` | 项目记忆 | 重大事件 |

---

## 📋 文档生命周期管理

### 生命周期阶段

```
创建 → 审查 → 发布 → 维护 → 归档 → 清理
  ↓      ↓      ↓      ↓      ↓      ↓
Draft  Review  Active  Update  Archive Delete
```

### 状态标识

在文档开头使用状态徽章：

```markdown
<!-- 草稿 -->
> **状态**: 🟡 草稿 | **创建**: 2026-02-18 | **作者**: 阿策

<!-- 审查中 -->
> **状态**: 🔵 审查中 | **审查者**: mlamp | **截止**: 2026-02-20

<!-- 已发布 -->
> **状态**: 🟢 已发布 | **版本**: 1.0 | **发布**: 2026-02-18

<!-- 已废弃 -->
> **状态**: 🔴 已废弃 | **替代**: [新文档](link) | **废弃**: 2026-03-01
```

### 归档策略

| 文档类型 | 保留期限 | 归档位置 | 清理策略 |
|----------|----------|----------|----------|
| ADR | 永久 | `docs/adr/` | 不删除，标记为废弃 |
| 代码审查报告 | 永久 | `docs/reports/reviews/` | 不删除 |
| 每日总结 | 3个月 | `docs/reports/daily/archive/` | 3个月后归档 |
| 阶段报告 | 永久 | `docs/reports/phases/` | 不删除 |
| 修复报告 | 6个月 | `docs/reports/fixes/archive/` | 6个月后归档 |
| 优化报告 | 6个月 | `docs/reports/optimizations/archive/` | 6个月后归档 |

---

## 🛠️ 文档工具和自动化

### 1. 报告归档脚本

```bash
# scripts/docs/archive-report.sh
# 用法：./scripts/docs/archive-report.sh TONIGHT_SUMMARY.md daily
```

**功能**：
- 自动识别文档类型
- 重命名为规范格式（YYYY-MM-DD-type-desc.md）
- 移动到对应目录
- 更新索引文件

### 2. 索引生成脚本

```bash
# scripts/docs/generate-index.sh
# 用法：./scripts/docs/generate-index.sh docs/reports/reviews
```

**功能**：
- 扫描目录下所有文档
- 提取元数据（日期、标题、状态）
- 生成 Markdown 表格索引
- 更新 README.md

### 3. 链接检查脚本

```bash
# scripts/docs/check-links.sh
# 用法：./scripts/docs/check-links.sh docs/
```

**功能**：
- 检查所有 Markdown 文件的内部链接
- 报告断链
- 建议修复方案

### 4. 文档清理脚本

```bash
# scripts/docs/cleanup-old-docs.sh
# 用法：./scripts/docs/cleanup-old-docs.sh --dry-run
```

**功能**：
- 根据归档策略自动归档过期文档
- 生成归档报告
- 支持 dry-run 模式预览

---

## 📝 文档编写规范

### 命名规范

#### 1. 根目录文档

```
UPPERCASE_WITH_UNDERSCORES.md
```

**示例**：`ARCHITECTURE.md`, `CHANGELOG.md`

#### 2. docs/ 目录文档

```
lowercase-with-hyphens.md
```

**示例**：`memory-system.md`, `skill-routing.md`

#### 3. 报告文档

```
YYYY-MM-DD-{type}-{description}.md
```

**示例**：`2026-02-18-review-round-6.md`

### 结构模板

#### ADR 模板

参考：`docs/adr/template.md`

#### 报告模板

```markdown
# {报告标题}

> **日期**: YYYY-MM-DD
> **作者**: 姓名
> **类型**: 代码审查/修复总结/优化报告
> **状态**: 🟢 已发布

---

## 摘要

（简短摘要，3-5句话）

---

## 主要内容

### 1. ...

### 2. ...

---

## 统计数据

（关键指标）

---

## 下一步行动

（待办事项）

---

## 相关文档

- [前置工作](link)
- [后续工作](link)
```

### Markdown 风格指南

1. **标题层级**：最多使用 4 级标题（`####`）
2. **列表**：使用 `-` 而不是 `*`
3. **代码块**：总是指定语言 ` ```typescript `
4. **表格**：使用对齐符号 `|---|---|`
5. **链接**：使用相对路径
6. **图片**：存储在 `docs/assets/images/`
7. **Emoji**：适度使用，增强可读性

---

## 🔍 文档索引系统

### 全局索引文件

| 索引文件 | 覆盖范围 | 更新频率 |
|----------|----------|----------|
| `DOCUMENTATION.md` | 全项目文档 | 新增目录时 |
| `docs/README.md` | docs/ 目录 | 每周 |
| `docs/adr/README.md` | ADR | 新增 ADR 时 |
| `docs/reports/README.md` | 所有报告 | 新增报告时 |

### 交叉引用网络

```
ARCHITECTURE.md
    ↓
docs/adr/001-multi-agent.md
    ↓
docs/specifications/discord-bot.md
    ↓
docs/reports/reviews/2026-02-18-round-6.md
    ↓
docs/reports/fixes/2026-02-18-p0-complete.md
```

**原则**：每个文档都应该链接到：
- ✅ 上游文档（背景、依赖）
- ✅ 下游文档（实现、应用）
- ✅ 相关文档（同主题）

---

## 🎯 文档管理最佳实践

### 1. 文档优先原则

```
编码前 → 写 ADR（决策）
编码后 → 写 Spec（规范）
审查后 → 写 Report（报告）
发布后 → 更新 CHANGELOG
```

### 2. 最小维护原则

**好文档**：
- ✅ 自动生成（索引、统计）
- ✅ 明确归档策略（自动清理）
- ✅ 清晰的生命周期（状态标识）

**坏文档**：
- ❌ 需要手动同步
- ❌ 永远不过期
- ❌ 没有所有者

### 3. 可发现性原则

**任何文档都应该能通过以下方式找到**：

1. **从入口出发**：README.md → DOCUMENTATION.md → 目标文档
2. **通过搜索**：关键词 grep/find
3. **通过索引**：docs/*/README.md 索引表格
4. **通过链接**：相关文档的交叉引用

### 4. 单一来源原则

**同一信息只在一处维护**：

- ❌ 坏示例：README.md 和 docs/quickstart.md 都写快速开始
- ✅ 好示例：README.md 概述 + 链接到 docs/quickstart.md

### 5. 版本控制原则

**文档和代码一起演进**：

```bash
# 好：文档和代码在同一个 commit
git commit -m "feat: add safeResponse + update ARCHITECTURE.md"

# 坏：文档滞后
git commit -m "feat: add safeResponse"
# ... 3 天后 ...
git commit -m "docs: update ARCHITECTURE.md"
```

---

## 📊 文档健康度检查

### 健康度指标

| 指标 | 目标 | 当前 | 状态 |
|------|------|------|------|
| 根目录文档数量 | <10 | 47 | 🔴 需改进 |
| 归档率 | >90% | 10% | 🔴 需改进 |
| 索引覆盖率 | 100% | 50% | 🟡 进行中 |
| 链接有效率 | >95% | - | ⏳ 待检查 |
| 更新及时性 | <7天 | - | ⏳ 待检查 |

### 月度检查清单

- [ ] 检查所有索引文件是否更新
- [ ] 归档过期文档（按归档策略）
- [ ] 检查断链（运行 check-links.sh）
- [ ] 更新文档统计
- [ ] 审查状态标识（草稿→已发布）

---

## 🚀 行动计划

### Phase 1: 清理和归档（本周）

1. ✅ 创建 `docs/reports/` 目录结构
2. ✅ 创建索引文件（README.md）
3. ⏳ 移动根目录下的 47 个文档到对应目录
4. ⏳ 更新所有索引

### Phase 2: 工具化（下周）

1. ⏳ 编写 `archive-report.sh` 脚本
2. ⏳ 编写 `generate-index.sh` 脚本
3. ⏳ 编写 `check-links.sh` 脚本
4. ⏳ 集成到 Git hooks

### Phase 3: 规范化（2周内）

1. ⏳ 统一文档命名
2. ⏳ 添加状态标识
3. ⏳ 建立交叉引用网络
4. ⏳ 创建文档编写指南

### Phase 4: 自动化（1个月内）

1. ⏳ 自动归档旧文档
2. ⏳ 自动生成索引
3. ⏳ CI 检查文档质量
4. ⏳ 文档健康度仪表板

---

## 🔗 相关资源

- [ADR 系统](docs/adr/README.md) - 架构决策记录规范
- [报告归档](docs/reports/README.md) - 工作报告管理规范
- [系统架构](ARCHITECTURE.md) - 技术架构文档
- [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)
- [Markdown 风格指南](https://google.github.io/styleguide/docguide/style.html)

---

**文档管理是持续的工程，每次改进都让项目更健康！** ✨

---

**最后更新**: 2026-02-18
**维护者**: Claude Code (阿策)
**状态**: 🟢 已发布
