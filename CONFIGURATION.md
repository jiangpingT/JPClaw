# JPClaw 配置指南

## 📋 目录

- [环境变量](#环境变量)
- [配置验证](#配置验证)
- [Benchmark 配置](#benchmark-配置)
- [网络连接测试](#网络连接测试)
- [常见问题](#常见问题)

---

## 环境变量

### 核心配置

#### 运行环境
```bash
NODE_ENV=development|production
# - development: 开发环境（启用 Benchmark 自动运行、详细日志）
# - production: 生产环境（禁用 Benchmark、精简日志）
```

#### 网关配置
```bash
JPCLAW_HOST=0.0.0.0          # 监听地址（默认: localhost）
JPCLAW_PORT=3000             # 监听端口（默认: 3000）
```

#### 数据目录
```bash
JPCLAW_DATA_DIR=./data       # 数据存储目录（默认: ./data）
```

---

### Benchmark 配置

#### 自动运行控制
```bash
# Benchmark 自动运行（启动后延迟执行）
JPCLAW_AUTO_BENCHMARK=true|false
# - true: 强制启用自动运行
# - false: 强制禁用自动运行
# - 未设置: 根据 NODE_ENV 决定（开发环境启用，生产环境禁用）

# Benchmark 延迟时间（秒）
JPCLAW_BENCHMARK_DELAY=30
# 默认: 30 秒
# 建议: 10-60 秒（避免启动时资源竞争）
```

#### 测试目录和文件
```bash
# 测试用例目录
JPCLAW_BENCHMARK_TEST_DIR=./benchmark-test-cases
# 默认: ./benchmark-test-cases

# 报告输出目录
JPCLAW_BENCHMARK_REPORT_DIR=./benchmark-reports
# 默认: ./benchmark-reports

# 测试用例文件名（相对于 TEST_DIR）
JPCLAW_TEST_CORRECTNESS=correctness.json
JPCLAW_TEST_GENERALIZATION=generalization.json
JPCLAW_TEST_AI_NATIVE=ai-native.json
```

**示例配置：**

```bash
# 开发环境（自动运行 Benchmark）
NODE_ENV=development
# Benchmark 会在启动 30 秒后自动运行

# 生产环境（禁用 Benchmark）
NODE_ENV=production
# Benchmark 不会自动运行，需要手动触发

# 生产环境强制启用 Benchmark
NODE_ENV=production
JPCLAW_AUTO_BENCHMARK=true
JPCLAW_BENCHMARK_DELAY=60
# Benchmark 会在启动 60 秒后运行

# 自定义测试目录
JPCLAW_BENCHMARK_TEST_DIR=/path/to/custom/tests
JPCLAW_BENCHMARK_REPORT_DIR=/path/to/custom/reports
```

---

### Provider 配置

#### Anthropic
```bash
ANTHROPIC_API_KEY=sk-ant-...
# Anthropic Claude API Key（必需）
```

#### OpenAI
```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
# OpenAI API Key 和 Base URL（可选，支持本地模型）
```

---

### Discord 配置

#### 单 Bot 模式
```bash
DISCORD_BOT_TOKEN=...       # Bot Token
DISCORD_APPLICATION_ID=...  # Application ID
```

#### 多 Bot 模式
通过 `jpclaw.config.json` 配置，支持多个 Discord Bot 实例。

---

## 配置验证

JPClaw 启动时会自动验证配置，确保系统可正常运行。

### 验证选项

配置验证可通过 `ValidationOptions` 控制：

```typescript
interface ValidationOptions {
  checkPortAvailability?: boolean;      // 端口可用性检查（默认: true）
  checkFilePermissions?: boolean;       // 文件权限检查（默认: true）
  checkNetworkConnectivity?: boolean;   // 网络连接测试（默认: false）
}
```

### 验证内容

#### 1. 端口可用性检查（默认启用）

检查 Gateway 端口是否被占用：

```bash
✅ 端口 3000 可用
❌ 端口 3000 已被占用
```

**解决方法：**
- 修改 `JPCLAW_PORT` 环境变量
- 或关闭占用端口的进程

#### 2. 目录权限检查（默认启用）

检查以下目录的读写权限：
- `JPCLAW_DATA_DIR` (数据目录)
- `./benchmark-reports` (报告目录)
- `./log` (日志目录)

```bash
✅ 数据目录权限正常
⚠️  数据目录 ./data 不存在，已自动创建
❌ 数据目录 ./data 权限不足 (可读: true, 可写: false)
```

**解决方法：**
```bash
# 修复目录权限
chmod -R 755 ./data
chown -R $USER:$USER ./data
```

#### 3. API Key 验证（默认启用）

检查必需的 API Key 是否配置：

```bash
✅ Anthropic API Key 已配置
❌ Anthropic provider 缺少 API Key
⚠️  OpenAI provider 缺少 API Key（如果使用本地模型可忽略）
```

**解决方法：**
```bash
# 设置 API Key
export ANTHROPIC_API_KEY=sk-ant-...
```

#### 4. Discord 配置验证（默认启用）

检查 Discord Bot Token 是否配置：

```bash
✅ Discord Bot 配置正常
❌ Discord Bot 已启用但缺少 token
```

---

## 网络连接测试

网络连接测试**默认禁用**（因为较慢，增加启动时间）。

### 启用网络测试

在代码中设置：

```typescript
import { validateRuntimeConfig } from "./shared/config-validator.js";

const result = await validateRuntimeConfig(config, {
  checkNetworkConnectivity: true  // 启用网络测试
});
```

### 测试内容

#### 1. Anthropic API 连接测试

测试能否连接到 `https://api.anthropic.com`：

```bash
✅ Anthropic API 连接正常
⚠️  Anthropic API 连接测试失败: 连接超时
⚠️  Anthropic API 连接测试失败: HTTP 500
```

**测试原理：**
- 发送一个最小的 API 请求（1 token）
- 超时时间: 5 秒
- 任何非 5xx 响应（包括 401 认证错误）都视为连接正常

#### 2. Discord 网关连接测试

测试能否连接到 Discord Gateway：

```bash
✅ Discord 网关连接正常
⚠️  Discord 网关连接测试失败: 连接超时
```

**测试原理：**
- 请求 `https://discord.com/api/v10/gateway`
- 超时时间: 5 秒

---

## 验证结果输出

### 成功示例

```bash
✅ 配置验证通过
```

### 警告示例

```bash
✅ 配置验证通过

警告：
  ⚠️  数据目录 ./data 不存在，已自动创建
  ⚠️  OpenAI provider 缺少 API Key（如果使用本地模型可忽略）
```

### 失败示例

```bash
❌ 配置验证失败

错误：
  • 端口 3000 已被占用
  • Anthropic provider 缺少 API Key
  • 数据目录 ./data 权限不足 (可读: true, 可写: false)

警告：
  ⚠️  Anthropic API 连接测试失败: 连接超时
```

---

## 常见问题

### Q1: 启动时显示 "端口已被占用"

**原因：** 指定端口已被其他进程使用。

**解决方法：**
```bash
# 方法1：使用其他端口
export JPCLAW_PORT=3001

# 方法2：查找并关闭占用端口的进程
# macOS/Linux
lsof -ti:3000 | xargs kill -9

# Windows
netstat -ano | findstr :3000
taskkill /PID <PID> /F
```

---

### Q2: 启动时显示 "数据目录权限不足"

**原因：** 程序无法读写数据目录。

**解决方法：**
```bash
# 修复权限
chmod -R 755 ./data
chown -R $USER:$USER ./data

# 或使用其他目录
export JPCLAW_DATA_DIR=/tmp/jpclaw-data
```

---

### Q3: Benchmark 没有自动运行

**原因：** 可能是生产环境或被手动禁用。

**解决方法：**
```bash
# 检查当前配置
echo $NODE_ENV
echo $JPCLAW_AUTO_BENCHMARK

# 强制启用
export JPCLAW_AUTO_BENCHMARK=true
```

---

### Q4: 网络连接测试失败但功能正常

**原因：** 网络测试对网络要求较高，可能受代理、防火墙影响。

**解决方法：**
- 网络测试是**可选的**，失败仅产生警告，不影响启动
- 如果实际使用正常，可以忽略警告
- 在内网环境建议禁用网络测试（默认已禁用）

---

### Q5: 自定义 Benchmark 测试用例位置

**示例：**
```bash
# 使用自定义目录
export JPCLAW_BENCHMARK_TEST_DIR=/path/to/my/tests
export JPCLAW_BENCHMARK_REPORT_DIR=/path/to/my/reports

# 使用自定义文件名
export JPCLAW_TEST_CORRECTNESS=my-correctness.json
export JPCLAW_TEST_GENERALIZATION=my-generalization.json
export JPCLAW_TEST_AI_NATIVE=my-ai-native.json
```

**代码中配置：**
```typescript
import { BenchmarkRunner } from "./benchmark/runner.js";

const runner = new BenchmarkRunner({
  testCasesDir: "/path/to/my/tests",
  reportsDir: "/path/to/my/reports",
  testFiles: {
    correctness: "my-correctness.json",
    generalization: "my-generalization.json",
    aiNative: "my-ai-native.json"
  }
});
```

---

## 完整配置示例

### 开发环境

```bash
# .env.development

# 运行环境
NODE_ENV=development

# Gateway
JPCLAW_HOST=localhost
JPCLAW_PORT=3000

# Benchmark（自动运行）
JPCLAW_AUTO_BENCHMARK=true
JPCLAW_BENCHMARK_DELAY=30

# Provider
ANTHROPIC_API_KEY=sk-ant-...

# Discord
DISCORD_BOT_TOKEN=...
DISCORD_APPLICATION_ID=...
```

### 生产环境

```bash
# .env.production

# 运行环境
NODE_ENV=production

# Gateway
JPCLAW_HOST=0.0.0.0
JPCLAW_PORT=3000

# Benchmark（禁用自动运行）
JPCLAW_AUTO_BENCHMARK=false

# 数据目录
JPCLAW_DATA_DIR=/var/lib/jpclaw/data

# Provider
ANTHROPIC_API_KEY=sk-ant-...

# Discord
DISCORD_BOT_TOKEN=...
DISCORD_APPLICATION_ID=...
```

---

## 参考资源

- **配置验证代码**: `src/js/shared/config-validator.ts`
- **Benchmark Runner**: `src/js/benchmark/runner.ts`
- **Gateway 启动**: `src/js/gateway/index.ts`
- **优化报告**: `OPTIMIZATION_COMPLETION_REPORT.md`

---

**最后更新**: 2026-02-18
