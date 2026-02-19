# 媒体功能快速参考

## 📚 文档索引

| 文档 | 描述 | 路径 |
|------|------|------|
| 优化报告 | 详细的优化建议和实施指南 | `OPTIMIZATION_REPORT.md` |
| 测试用例 | 80+ 完整测试用例文档 | `MEDIA_TEST_CASES.md` |
| 测试指南 | 如何运行和编写测试 | `tests/README.md` |
| 快速参考 | 本文档 - 快速查询手册 | `QUICK_REFERENCE.md` |

---

## 🎯 当前功能概览

### ✅ 已实现

| 功能 | 提供商 | 文件路径 | 说明 |
|------|--------|----------|------|
| 图片生成 | OpenAI, Gemini | `skills/openai-image-gen/` | 支持高质量、图片编辑(最多14张) |
| 视频生成 | OpenAI, Gemini | `skills/video-frames/` | 支持自定义时长、分辨率、宽高比 |
| 字幕提取 | YouTube | `skills/transcript-fast/` | 多语言字幕、时间轴信息 |
| 媒体路由 | 通用 | `skills/_shared/media-router.js` | 预算管理、提供商选择、成本估算 |

### ❌ 缺失功能

| 功能 | 优先级 | 建议实施时间 |
|------|--------|-------------|
| 音频生成 (TTS) | 🔴 高 | 1-2周 |
| 语音识别 (STT) | 🔴 高 | 1-2周 |
| 请求缓存 | 🟢 低 | 可选 |
| 并发控制 | 🟢 低 | 可选 |

---

## 🔧 快速使用指南

### 图片生成

```javascript
// 基础用法
{
  "prompt": "一只可爱的猫咪",
  "quality": "standard"
}

// 高级用法 - 指定提供商和质量
{
  "prompt": "未来主义城市景观",
  "provider": "openai",
  "quality": "high",
  "size": "1024x1024"
}

// 图片编辑
{
  "prompt": "将背景改为海滩",
  "input_images": ["./path/to/image.png"],
  "quality": "high"
}
```

### 视频生成

```javascript
{
  "prompt": "海浪拍打沙滩",
  "provider": "gemini",
  "duration_seconds": 8,
  "aspect_ratio": "16:9",
  "quality": "standard"
}
```

### 字幕提取

```javascript
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "languages": ["zh-Hans", "en"],
  "maxSegments": 500
}
```

---

## 💰 预算配置

### 环境变量

```bash
# 全局预算
export MEDIA_DAILY_BUDGET_USD=10.0

# 分类预算
export MEDIA_IMAGE_DAILY_BUDGET_USD=5.0
export MEDIA_VIDEO_DAILY_BUDGET_USD=5.0

# 超限行为: reject(拒绝) 或 degrade(降级)
export MEDIA_BUDGET_ON_EXCEEDED=degrade

# Budget模式
# free_first: 优先使用免费/便宜的提供商
# quality_first: 优先使用高质量提供商
```

### 成本参考

| 类型 | 提供商 | 质量 | 成本(USD) |
|------|--------|------|----------|
| 图片 | OpenAI | standard | $0.04 |
| 图片 | OpenAI | high | $0.08 |
| 图片 | Gemini | standard | $0.01 |
| 图片 | Gemini | high | $0.03 |
| 视频 | OpenAI Sora | standard | $0.60 |
| 视频 | OpenAI Sora | high | $1.20 |
| 视频 | Gemini Veo | standard | $0.40 |
| 视频 | Gemini Veo | high | $0.80 |

---

## 🛡️ 安全配置

### API密钥

```bash
# 必需
export GEMINI_API_KEY="your-key"
export OPENAI_API_KEY="your-key"

# 多密钥轮换 (建议)
export OPENAI_API_KEYS="key1,key2,key3"
```

### 代理设置

```bash
# HTTP/HTTPS代理
export HTTPS_PROXY=http://localhost:8888
export HTTP_PROXY=http://localhost:8888

# SOCKS5代理
export HTTPS_PROXY=socks5://localhost:1080

# 禁用代理
export OPENAI_USE_PROXY=false
export GEMINI_USE_PROXY=false

# 特定提供商代理
export OPENAI_PROXY_URL=http://openai-proxy:8888
export GEMINI_PROXY_URL=http://gemini-proxy:8888
```

### 文件路径白名单

默认允许的路径:
- `sessions/` - 会话数据
- `assets/` - 资源文件

---

## 🔍 错误代码速查

| 错误代码 | 含义 | 解决方案 |
|----------|------|----------|
| `missing_prompt` | 缺少prompt参数 | 提供有效的prompt |
| `missing_OPENAI_API_KEY` | 缺少API密钥 | 设置环境变量 |
| `budget_exceeded` | 预算超限 | 增加预算或等待次日 |
| `invalid_json` | JSON解析失败 | 检查输入格式 |
| `Path not allowed` | 路径安全检查失败 | 使用允许的路径 |
| `openai_image_failed` | OpenAI API错误 | 检查API密钥、网络、代理 |
| `gemini_video_failed` | Gemini API错误 | 检查API密钥、配额 |
| `invalid_youtube_url` | 无效的YouTube URL | 使用正确的YouTube链接 |
| `no_captions_available` | 视频无字幕 | 使用有字幕的视频 |

---

## 🚀 优化清单

### 立即实施 (P0 - 高优先级)

- [ ] **添加音频TTS功能**
  - 创建 `skills/audio-tts/index.js`
  - 支持 OpenAI TTS, Google Cloud TTS
  - 集成预算系统

- [ ] **添加音频STT功能**
  - 创建 `skills/audio-stt/index.js`
  - 支持 OpenAI Whisper, Google Speech-to-Text
  - 支持多种音频格式

- [ ] **结构化错误处理**
  - 创建 `skills/_shared/media-errors.js`
  - 定义错误代码枚举
  - 统一错误格式

### 短期改进 (P1 - 中优先级)

- [ ] **增强输入验证**
  - 创建 `skills/_shared/media-validator.js`
  - 验证prompt长度、格式
  - 验证文件大小、格式

- [ ] **添加监控指标**
  - 创建 `skills/_shared/media-metrics.js`
  - 记录成功率、延迟
  - 生成统计报告

- [ ] **安全性改进**
  - 加强路径遍历防护
  - API密钥轮换
  - 日志脱敏

### 长期优化 (P2/P3 - 低优先级)

- [ ] 请求缓存 (`media-cache.js`)
- [ ] 并发控制 (`media-queue.js`)
- [ ] 图片元数据嵌入
- [ ] 性能优化(流式传输、压缩)

---

## 🧪 测试快速开始

### 运行基础测试

```bash
# 1. 设置API密钥
export GEMINI_API_KEY="your-key"

# 2. (可选) 跳过昂贵测试
export SKIP_EXPENSIVE_TESTS=true

# 3. 运行测试
node tests/media-basic-test.js
```

### 测试覆盖

当前测试覆盖:
- ✅ 基础功能测试 (12个)
- ✅ 边界条件测试
- ✅ 安全性测试
- ✅ 集成测试
- ⏳ 性能测试 (待添加)
- ⏳ 负载测试 (待添加)

---

## 📊 监控和维护

### 检查预算使用

```bash
# 查看预算账本
cat sessions/media/budget-ledger.json

# 使用jq格式化查看今日使用
jq '.["2026-02-14"]' sessions/media/budget-ledger.json
```

### 清理旧数据

```bash
# 清理测试文件
rm -rf sessions/media/test-outputs/

# 重置预算记录
rm sessions/media/budget-ledger.json

# 清理缓存 (未来功能)
rm sessions/media/cache.json
```

### 健康检查

```javascript
// 创建健康检查脚本
import { checkBudget } from './skills/_shared/media-router.js';

const health = checkBudget('image', 0);
console.log('Budget Health:', health.ok ? '✓' : '✗');
console.log('Today Usage:', health.day);
```

---

## 🔗 常用命令

```bash
# 开发
npm run dev

# 测试
node tests/media-basic-test.js

# 检查预算
cat sessions/media/budget-ledger.json | jq

# 查看日志
tail -f sessions/media/logs/*.log

# 清理
rm -rf sessions/media/test-outputs/
```

---

## 📞 获取帮助

### 问题诊断流程

1. **检查环境变量** - API密钥、代理设置
2. **查看错误代码** - 参考上方错误代码表
3. **查看详细文档** - `OPTIMIZATION_REPORT.md`
4. **运行测试** - 验证功能是否正常
5. **查看测试用例** - `MEDIA_TEST_CASES.md` 寻找类似场景

### 文档结构

```
JPClaw/
├── OPTIMIZATION_REPORT.md    # 详细优化建议
├── MEDIA_TEST_CASES.md       # 完整测试用例
├── QUICK_REFERENCE.md        # 本文档
├── tests/
│   ├── README.md             # 测试指南
│   └── media-basic-test.js   # 基础测试套件
├── skills/
│   ├── openai-image-gen/     # 图片生成
│   ├── video-frames/         # 视频生成
│   ├── transcript-fast/      # 字幕提取
│   └── _shared/
│       └── media-router.js   # 媒体路由器
└── sessions/
    └── media/
        ├── budget-ledger.json  # 预算记录
        ├── images/             # 生成的图片
        └── test-outputs/       # 测试输出
```

---

## 🎓 最佳实践

### ✅ 推荐

1. **使用预算控制** - 避免意外开销
2. **启用降级模式** - 提高可用性
3. **配置重试机制** - 处理临时故障
4. **监控使用情况** - 定期检查预算账本
5. **编写测试用例** - 确保功能稳定

### ❌ 避免

1. 硬编码API密钥
2. 不检查预算直接调用
3. 忽略错误信息
4. 不清理测试文件
5. 跳过输入验证

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0 | 2026-02-14 | 初始版本 - 现状分析和优化建议 |

---

**提示**: 此文档是快速参考，详细信息请查看对应的完整文档。
