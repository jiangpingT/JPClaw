# JPClaw CLI 测试指南

## 🎯 概述

现在你可以通过 CLI 命令直接测试 JPClaw 的技能路由功能，无需手动在 Discord 中发送消息！

---

## 📋 前提条件

**必须先启动 gateway**：

```bash
# 方法1: 直接启动（前台运行）
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js gateway

# 方法2: 使用launchd（后台运行）
launchctl load ~/Library/LaunchAgents/com.jpclaw.gateway.plist

# 方法3: npm 脚本
npm run gateway
```

验证 gateway 是否运行：

```bash
curl http://127.0.0.1:8341/health
```

应该返回类似：`{"status":"healthy",...}`

---

## 🚀 新增 CLI 命令

### 1. `jpclaw chat` - 发送单个查询

#### 用法

```bash
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js chat "你的查询"
```

#### 示例

```bash
# 测试 web-search
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js chat "搜索一下今天的科技新闻"

# 测试 map-poi
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js chat "附近有什么咖啡馆"

# 测试 weather
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js chat "查询北京的天气"

# 测试 openai-image-gen
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js chat "生成一张未来城市的图片"
```

#### 输出示例

```
📤 发送查询: "搜索一下今天的科技新闻"

📥 JPClaw 回复 (2341ms):

正在调用 web-search 技能...
[搜索结果内容]
```

---

### 2. `jpclaw test-routing` - 批量测试

#### 用法

```bash
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js test-routing [选项]
```

#### 选项

| 选项 | 说明 | 示例 |
|------|------|------|
| `--limit N` | 只测试前N个用例 | `--limit 10` |
| `--priority <p>` | 只测试指定优先级 (high/medium/low) | `--priority high` |
| `--category <c>` | 只测试指定类别 | `--category "搜索与信息"` |
| `--output <file>` | 保存结果到指定文件 | `--output results.json` |
| `--help, -h` | 显示帮助 | `--help` |

#### 示例

```bash
# 测试前10个用例
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js test-routing --limit 10

# 只测试高优先级技能
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js test-routing --priority high

# 只测试"搜索与信息"类别
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js test-routing --category "搜索与信息"

# 测试所有80个技能
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js test-routing

# 保存结果到指定文件
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js test-routing --output my-test-results.json
```

#### 输出示例

```
🚀 JPClaw 路由测试

═══════════════════════════════════════

📋 测试用例数: 80

开始测试...

═══════════════════════════════════════

[1/80] 测试: web-search
    查询: "搜索一下今天的科技新闻"
    期望: web-search
    ✅ 通过 (耗时: 2341ms)

[2/80] 测试: map-poi
    查询: "附近有什么咖啡馆"
    期望: map-poi
    ✅ 通过 (耗时: 1892ms)

...

═══════════════════════════════════════
  测试完成
═══════════════════════════════════════

📊 总测试数: 80
✅ 通过: 72
❌ 失败: 8
📈 通过率: 90.0%
⏱️  平均耗时: 1523ms

📊 按类别统计:
   搜索与信息: 8/10 (80%)
   地图与位置: 5/5 (100%)
   内容生成: 6/8 (75%)
   ...

📄 详细报告: /Users/mlamp/Workspace/JPClaw/tests/routing-test-1771123456789.json
📄 Markdown 报告: /Users/mlamp/Workspace/JPClaw/tests/routing-test-1771123456789.md
```

---

## 📊 如何判断路由成功？

### ✅ 成功标志

1. **响应中包含技能名称**：
   - "正在调用 web-search 技能"
   - "调用技能: map-poi"
   - "使用技能: weather"

2. **技能名称匹配期望**：
   - 期望 `web-search`，实际路由到 `web-search` ✅
   - 期望 `map-poi`，实际路由到 `goplaces` ❌

### ❌ 失败标志

1. **AI直接回复**：没有调用任何技能，只是用模型回答
2. **路由到错误技能**：调用了其他技能
3. **未检测到路由信息**：响应中没有技能相关文本

---

## 🔍 查看详细日志

测试时同时运行日志监控：

```bash
# 在另一个终端窗口运行
tail -f /Users/mlamp/Workspace/JPClaw/log/gateway.log | grep -E "skill_router|selected"
```

成功的日志示例：

```
skill_router.selected: { name: 'web-search', confidence: 0.95, reason: '...' }
```

---

## 🎯 完整测试流程

### 快速测试（推荐）

```bash
# 1. 确保gateway运行
curl http://127.0.0.1:8341/health

# 2. 测试前10个高优先级技能
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js test-routing --limit 10 --priority high

# 3. 查看结果
ls -lh /Users/mlamp/Workspace/JPClaw/tests/routing-test-*.json
```

### 完整测试（80个技能）

```bash
# 1. 启动日志监控（可选）
tail -f /Users/mlamp/Workspace/JPClaw/log/gateway.log | grep -E "skill_router|selected" &

# 2. 运行所有测试
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js test-routing

# 3. 查看报告
cat /Users/mlamp/Workspace/JPClaw/tests/routing-test-*.md
```

---

## 💡 使用技巧

### 1. 测试特定技能

```bash
# 直接用 chat 命令测试
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js chat "你要测试的查询"
```

### 2. 分批测试

```bash
# 先测试前20个
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js test-routing --limit 20

# 根据结果优化 description

# 再测试全部
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js test-routing
```

### 3. 对比优化前后效果

```bash
# 优化前
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js test-routing --output before.json

# 优化 SKILL.md 的 description

# 重启 gateway 加载新配置
launchctl stop com.jpclaw.gateway && launchctl start com.jpclaw.gateway

# 优化后
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js test-routing --output after.json

# 对比通过率
```

---

## 🚨 常见问题

### 1. `Request failed: connect ECONNREFUSED 127.0.0.1:8341`

**原因**: gateway 未运行

**解决**:

```bash
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js gateway
```

### 2. `Request timeout (60s)`

**原因**: 某个技能执行时间过长

**解决**: 这是正常的，该技能可能需要调用外部API或执行复杂操作

### 3. 所有测试都显示"未检测到技能路由"

**原因**: 响应格式可能不匹配提取模式

**解决**: 查看 `test-routing.ts` 中的 `extractSkillFromResponse()` 函数，根据实际响应格式调整正则表达式

---

## 📝 测试结果文件

测试完成后会生成两个文件：

### 1. JSON 报告 (`routing-test-*.json`)

```json
{
  "summary": {
    "total": 80,
    "passed": 72,
    "failed": 8,
    "passRate": 90.0,
    "avgDuration": 1523,
    "timestamp": "2026-02-15T02:30:00.000Z"
  },
  "results": [
    {
      "id": 1,
      "skill": "web-search",
      "query": "搜索一下今天的科技新闻",
      "expectedSkill": "web-search",
      "response": "正在调用 web-search 技能...",
      "duration": 2341,
      "timestamp": "2026-02-15T02:30:01.234Z",
      "success": true,
      "notes": "实际路由: web-search"
    }
  ],
  "byCategory": { ... }
}
```

### 2. Markdown 报告 (`routing-test-*.md`)

包含完整的测试结果，方便分享和查看。

---

## 🎉 开始测试吧！

```bash
# 一键测试前10个核心技能
node /Users/mlamp/Workspace/JPClaw/dist/cli/index.js test-routing --limit 10 --priority high
```

祝测试顺利！🚀
