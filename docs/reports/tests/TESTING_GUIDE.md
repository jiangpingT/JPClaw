# JPClaw 技能路由测试指南

## 🎯 测试目标

1. **验证中文描述的有效性**: 确保每个技能的中文 description 能够正确触发路由
2. **检测路由准确率**: 测量 AI 路由器的置信度和准确性
3. **发现实现问题**: 识别需要完善的技能
4. **性能基准**: 记录路由延迟和 token 消耗

## 📦 测试套件内容

### 已创建的文件

1. **skill-routing-tests.json** (80个测试用例)
   - 覆盖所有80个技能
   - 每个技能1个真实场景的中文查询
   - 分类标记（搜索与信息、地图与位置、图像生成等）
   - 优先级标记（high/medium/low）

2. **test-skill-routing.sh** (Bash 快速测试脚本)
   - 支持全量测试和部分测试
   - 支持按类别/优先级过滤
   - 生成 Markdown 格式报告
   - 彩色输出，易于查看

3. **run-skill-routing-tests.ts** (TypeScript 高级测试器)
   - 详细的测试统计
   - 性能分析
   - 可扩展的测试框架
   - （待完善：集成真实路由API）

4. **README.md** (测试套件文档)
   - 使用说明
   - 文件说明
   - 测试类别说明

## 🚀 快速开始

### 方式1: 快速测试（推荐新手）

```bash
cd /Users/mlamp/Workspace/JPClaw/tests

# 测试前5个技能
./test-skill-routing.sh --limit 5
```

### 方式2: 分类测试

```bash
# 测试高优先级技能（最重要的核心功能）
./test-skill-routing.sh --priority high

# 测试搜索相关技能
./test-skill-routing.sh --category "搜索与信息"

# 测试地图相关技能
./test-skill-routing.sh --category "地图与位置"
```

### 方式3: 完整测试

```bash
# 测试所有80个技能（约需1-2分钟）
./test-skill-routing.sh
```

## 📊 测试用例示例

### 高优先级技能（推荐优先测试）

| 技能 | 测试查询 | 类别 |
|------|---------|------|
| web-search | "搜索一下今天的科技新闻" | 搜索与信息 |
| map-poi | "附近有什么咖啡馆" | 地图与位置 |
| weather | "查询北京的天气" | 信息查询 |
| github | "查看 JPClaw 项目的最新 PR" | 开发工具 |
| coding-agent | "用 Codex 帮我重构这段代码" | 开发工具 |
| browser-automation | "打开网页并截图" | 浏览器自动化 |

### 常用技能

| 技能 | 测试查询 | 类别 |
|------|---------|------|
| openai-image-gen | "生成一张未来城市的图片" | 图像生成 |
| email-automation | "草拟一封邮件给客户" | 邮件管理 |
| doc-generation | "生成一份项目报告文档" | 文档生成 |
| notion | "在 Notion 创建一个新页面" | 笔记管理 |
| discord | "发送Discord消息到开发频道" | 通讯工具 |

## 📈 预期结果

### 理想状态

- ✅ **通过率 > 90%**: 大部分技能能正确路由
- ✅ **平均置信度 > 0.75**: AI 路由器有较高把握
- ✅ **高优先级技能 100% 通过**: 核心功能必须可靠

### 需要关注的情况

- ⚠️ 通过率 < 70%: description 可能需要优化
- ⚠️ 置信度 < 0.6: 触发词不够明确
- ❌ 核心技能路由失败: 紧急需要修复

## 🔧 如何使用测试结果

### 1. 识别需要优化的技能

测试完成后，查看报告中的失败项:

```markdown
### ❌ Test #42: goplaces
- **查询**: "搜索附近的寿司店"
- **期望**: goplaces
- **实际**: map-poi
- **结果**: 失败 ❌
- **原因**: 路由到了错误的技能
```

**分析**: `goplaces` 和 `map-poi` 功能相似，description 可能需要更明确的区分。

**优化建议**:
- 在 `goplaces` 的 description 中强调 "Google Places API"
- 在 `map-poi` 的 description 中强调 "高德地图 POI"

### 2. 调整 description

如果某个技能路由失败，检查其 SKILL.md:

```bash
cat skills/goplaces/SKILL.md
```

优化 description，增加更多触发词示例:

```yaml
description: Google Places API 查询工具。使用 goplaces CLI 进行文本搜索、
地点详情、地址解析。适用于"搜索XX地点"、"查找附近XX"、"Google Places XX"、
"goplaces搜索"等查询。需要 Google Places API Key。
```

### 3. 重新测试

```bash
# 重启服务加载新描述
npm run restart

# 重新测试该技能
./test-skill-routing.sh --limit 1  # 测试第一个
```

## 🎨 测试报告样例

测试完成后会生成如下报告:

```markdown
# JPClaw 技能路由测试报告

**生成时间**: 2026-02-15 14:30:22

## 测试概览

- 📊 **总测试数**: 80
- ✅ **通过**: 72
- ❌ **失败**: 8
- 📈 **通过率**: 90.0%

---

### ✅ Test #1: web-search
- **查询**: "搜索一下今天的科技新闻"
- **期望**: web-search
- **实际**: web-search
- **置信度**: 0.88
- **结果**: 通过 ✅

### ❌ Test #42: goplaces
- **查询**: "搜索附近的寿司店"
- **期望**: goplaces
- **实际**: map-poi
- **结果**: 失败 ❌
- **原因**: 路由到了错误的技能
```

## 🔄 持续改进流程

1. **运行测试** → 获取基准数据
2. **分析失败项** → 找出问题技能
3. **优化 description** → 增加触发词、明确功能
4. **重新测试** → 验证改进效果
5. **迭代优化** → 直到通过率 > 90%

## ⚠️ 当前限制

1. **模拟路由**: 当前脚本使用启发式规则，不是真实的 AI 路由
2. **无技能执行**: 只测试路由，不执行技能（避免副作用）
3. **环境依赖**: 某些技能需要 API Keys 等配置

## 🚧 下一步开发

- [ ] 集成真实的 skill-router API
- [ ] 添加性能测试（延迟、token 消耗）
- [ ] 添加回归测试（防止 description 改动破坏现有功能）
- [ ] CI/CD 自动化测试

## 💡 测试最佳实践

1. **先测高优先级**: 核心功能最重要
2. **小步快跑**: 每次优化少量技能，及时验证
3. **记录变化**: 保存测试报告，对比改进效果
4. **真实场景**: 测试查询要符合实际用户使用习惯

## 📞 需要帮助？

如果遇到问题或需要添加新的测试用例，可以:
1. 编辑 `skill-routing-tests.json` 添加测试
2. 修改 `test-skill-routing.sh` 调整测试逻辑
3. 查看测试报告分析失败原因

---

**祝测试顺利！** 🎉
