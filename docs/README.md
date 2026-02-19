# JPClaw 文档中心

> **欢迎来到 JPClaw 文档中心** - 一站式文档导航

---

## 🚀 快速开始

**新用户**？从这里开始：

1. 📖 [项目简介](../README.md) - 了解 JPClaw 是什么
2. ⚙️ [配置指南](../CONFIGURATION.md) - 环境搭建和配置
3. 🏃 [快速开始](guides/quickstart/) - 5分钟上手

**开发者**？进阶阅读：

1. 🏛️ [系统架构](../ARCHITECTURE.md) - 技术架构全景
2. 📋 [架构决策记录](adr/README.md) - 重要决策的来龙去脉
3. 🔧 [开发指南](guides/development/) - 开发规范和最佳实践

---

## 📚 文档导航

### 🏛️ [架构决策记录（ADR）](adr/README.md)

记录重要的架构决策及其背景、方案对比和影响。

**最新 ADR**:
- [ADR-001: 多智能体协作系统架构](adr/001-multi-agent-collaboration.md)

**何时查看**：
- 想了解"为什么这样设计"
- 需要做重大架构决策
- 回顾历史决策

---

### 📊 [工作报告归档](reports/README.md)

所有代码审查、修复总结、优化报告的归档中心。

**报告类型**:
- 📋 [代码审查报告](reports/reviews/) - 代码质量审查
- 📅 [每日工作总结](reports/daily/) - 工作日志
- 🎯 [阶段性报告](reports/phases/) - 里程碑总结
- 🔧 [修复总结](reports/fixes/) - Bug 修复记录
- ⚡ [优化报告](reports/optimizations/) - 性能优化记录

**最新报告**:
- [2026-02-18 今晚工作总结](reports/daily/2026-02-18-daily-tonight-summary.md) - 7个P0+7个P1修复
- [2026-02-18 最终报告](reports/daily/2026-02-18-daily-tonight-final.md) - 系统重启成功

**何时查看**：
- 回顾项目历史
- 了解代码质量演进
- 查找修复记录

---

### 📖 使用指南（Guides）

#### 🏃 快速开始（Quickstart）

*待补充*

#### 💻 开发指南（Development）

*待补充*

#### 🚀 部署指南（Deployment）

*待补充*

#### 🔍 故障排查（Troubleshooting）

*待补充*

---

### 🔌 API 文档（API Reference）

#### HTTP API

*待补充*

#### WebSocket API

*待补充*

#### 内部 API

*待补充*

---

### 📐 技术规范（Specifications）

详细的技术规范和设计文档。

**核心规范**:
- [记忆系统规范](specifications/memory-system.md) - *待创建*
- [技能系统规范](specifications/skill-system.md) - *待创建*
- [安全规范](specifications/security.md) - *待创建*
- [编码规范](specifications/coding-standards.md) - *待创建*

**现有规范**:
- [记忆生命周期](memory-lifecycle.md)
- [知识图谱](knowledge-graph.md)
- [记忆 Embedding 升级](memory-embedding-upgrade.md)
- [记忆大小控制](memory-size-control.md)
- [技能路由说明](SKILL_ROUTING_EXPLAINED.md)
- [技能命名优化](SKILL_NAMING_OPTIMIZATION.md)
- [置信度说明](CONFIDENCE_EXPLAINED.md)
- [描述编写指南](DESCRIPTION_WRITING_GUIDE.md)

---

## 🎯 按角色导航

### 👤 产品经理

- [项目简介](../README.md)
- [快速参考](../QUICK_REFERENCE.md)
- [版本历史](../CHANGELOG.md)

### 🏗️ 架构师

- [系统架构](../ARCHITECTURE.md)
- [架构决策记录](adr/README.md)
- [技术规范](specifications/)

### 💻 开发者

- [配置指南](../CONFIGURATION.md)
- [开发指南](guides/development/)
- [API 文档](api/)
- [代码审查标准](../CODE_REVIEW_STANDARDS.md)

### 🧪 测试工程师

- [测试用例](../MEDIA_TEST_CASES.md)
- [故障排查](guides/troubleshooting/)

### 🚀 运维工程师

- [重启指南](../RESTART_GUIDE.md)
- [部署指南](guides/deployment/)

### 🔍 代码审查者

- [代码审查报告](reports/reviews/)
- [代码审查标准](../CODE_REVIEW_STANDARDS.md)

---

## 📊 文档统计

**截至 2026-02-18**:

| 分类 | 数量 | 状态 |
|------|------|------|
| ADR | 1 | ✅ 已建立 |
| 代码审查报告 | 6 | ⏳ 待归档 |
| 每日总结 | 2 | ✅ 已归档 |
| 阶段报告 | 5 | ⏳ 待归档 |
| 修复报告 | 5 | ⏳ 待归档 |
| 优化报告 | 2 | ⏳ 待归档 |
| 技术规范 | 8 | ✅ 已迁移 |

**文档健康度**: 🟡 改进中

---

## 🛠️ 文档工具

### 归档工具

```bash
# 归档单个报告
./scripts/docs/archive-report.sh <文件名> <类型>

# 批量归档
./scripts/docs/batch-archive.sh

# 生成索引
./scripts/docs/generate-index.sh  # 待实现

# 检查链接
./scripts/docs/check-links.sh  # 待实现
```

### 文档命名规范

- **根目录文档**: `UPPERCASE_WITH_UNDERSCORES.md`
- **docs/ 文档**: `lowercase-with-hyphens.md`
- **报告文档**: `YYYY-MM-DD-{type}-{description}.md`

详见：[文档架构总览](../DOCUMENTATION.md)

---

## 🔍 搜索文档

### 按主题搜索

```bash
# 搜索记忆系统相关文档
grep -r "memory" docs/ --include="*.md"

# 搜索 Discord 相关文档
grep -r "discord" docs/ --include="*.md"
```

### 按时间搜索

```bash
# 查找 2026-02-18 的所有文档
find docs/ -name "*2026-02-18*"
```

### 按类型搜索

```bash
# 查找所有 ADR
ls docs/adr/*.md

# 查找所有审查报告
ls docs/reports/reviews/*.md
```

---

## 📝 贡献文档

### 创建新文档

1. **确定文档类型**（ADR / 报告 / 指南 / 规范）
2. **选择合适的目录**
3. **使用相应的模板**
4. **遵循命名规范**
5. **更新索引**

### 文档审查清单

- [ ] 标题清晰
- [ ] 结构完整
- [ ] 链接有效
- [ ] 代码示例可运行
- [ ] 更新了索引
- [ ] 添加了状态标识

详见：[文档架构总览](../DOCUMENTATION.md)

---

## 🔗 相关资源

- [文档架构总览](../DOCUMENTATION.md) - 完整的文档管理规范
- [项目 README](../README.md) - 项目入口
- [系统架构](../ARCHITECTURE.md) - 技术架构
- [版本历史](../CHANGELOG.md) - 变更记录

---

## 📬 反馈

发现文档问题？

1. 📝 提交 Issue
2. 💬 直接修改并提交 PR
3. 💡 联系维护者

---

**文档让知识流动，让协作更高效！** ✨

---

**最后更新**: 2026-02-18
**维护者**: Claude Code (阿策)
**状态**: 🟢 持续更新中
