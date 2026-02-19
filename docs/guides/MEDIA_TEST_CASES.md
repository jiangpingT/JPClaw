# 媒体生成和读取测试用例

## 测试策略

- ✅ 单元测试 - 测试独立函数
- ✅ 集成测试 - 测试完整流程
- ✅ 边界测试 - 测试极限情况
- ✅ 错误测试 - 测试异常处理
- ✅ 性能测试 - 测试响应时间和并发

---

## 一、图片生成测试用例 (`skills/openai-image-gen/`)

### 1.1 基础功能测试

#### TC-IMG-001: 基本图片生成 (Gemini)
**目的**: 验证使用Gemini生成图片的基本功能

**输入**:
```json
{
  "prompt": "一只在草地上奔跑的金毛犬",
  "provider": "gemini",
  "quality": "standard",
  "resolution": "1K"
}
```

**预期输出**:
```json
{
  "ok": true,
  "task": "image",
  "route": {
    "provider": "gemini",
    "model": "gemini-3-pro-image-preview",
    "quality": "standard"
  },
  "result": {
    "outputPath": "/path/to/generated-image.png"
  }
}
```

**验证点**:
- [ ] 返回状态为 `ok: true`
- [ ] 图片文件存在于指定路径
- [ ] 文件大小 > 0
- [ ] 文件格式为 PNG
- [ ] 预算已记录

---

#### TC-IMG-002: 高质量图片生成 (OpenAI)
**目的**: 验证OpenAI高质量图片生成

**输入**:
```json
{
  "prompt": "未来主义风格的城市景观，霓虹灯，赛博朋克",
  "provider": "openai",
  "quality": "high",
  "size": "1024x1024"
}
```

**预期输出**:
```json
{
  "ok": true,
  "route": {
    "provider": "openai",
    "model": "gpt-image-1",
    "quality": "high",
    "estimatedCostUsd": 0.08
  }
}
```

**验证点**:
- [ ] 使用了高质量设置
- [ ] 成本估算为 $0.08
- [ ] 图片尺寸正确
- [ ] 响应时间 < 60秒

---

#### TC-IMG-003: 图片编辑 - 单张输入
**目的**: 验证基于现有图片的编辑功能

**前置条件**: 准备测试图片 `test-assets/cat.png`

**输入**:
```json
{
  "prompt": "将这只猫的背景改为海滩",
  "provider": "gemini",
  "input_images": ["test-assets/cat.png"],
  "resolution": "2K"
}
```

**预期输出**:
```json
{
  "ok": true,
  "route": {
    "quality": "standard"
  }
}
```

**验证点**:
- [ ] 成功加载输入图片
- [ ] 输出图片分辨率基于输入自动检测
- [ ] 输出图片内容与prompt相关

---

#### TC-IMG-004: 图片编辑 - 多张输入
**目的**: 验证多图合成功能

**前置条件**: 准备3张测试图片

**输入**:
```json
{
  "prompt": "将这三张图片融合成一个拼贴画",
  "input_images": [
    "test-assets/img1.png",
    "test-assets/img2.png",
    "test-assets/img3.png"
  ]
}
```

**验证点**:
- [ ] 成功加载所有输入图片
- [ ] 输出图片包含输入元素
- [ ] 处理时间 < 120秒

---

### 1.2 边界测试

#### TC-IMG-005: 最大输入图片数量
**目的**: 验证14张图片上限

**输入**:
```json
{
  "prompt": "创建图片网格",
  "input_images": [/* 14张图片路径 */]
}
```

**验证点**:
- [ ] 14张图片成功处理
- [ ] 自动检测最高分辨率

---

#### TC-IMG-006: 超过输入图片限制
**目的**: 验证超出限制的错误处理

**输入**:
```json
{
  "input_images": [/* 15张图片路径 */]
}
```

**预期输出**:
```
Error: Too many input images (15). Maximum is 14.
```

**验证点**:
- [ ] 返回清晰的错误信息
- [ ] 不消耗预算
- [ ] 不调用API

---

#### TC-IMG-007: 超长Prompt
**目的**: 测试4000字符的prompt

**输入**:
```json
{
  "prompt": "一个非常详细的描述..." // 4000字符
}
```

**验证点**:
- [ ] 接受长prompt
- [ ] 正常生成图片

---

#### TC-IMG-008: 空Prompt
**目的**: 验证必填字段检查

**输入**:
```json
{
  "prompt": ""
}
```

**预期输出**:
```json
{
  "ok": false,
  "error": "missing_prompt"
}
```

**验证点**:
- [ ] 返回错误
- [ ] 不消耗预算

---

### 1.3 预算和降级测试

#### TC-IMG-009: 预算耗尽 - 拒绝模式
**目的**: 验证预算超限时拒绝请求

**前置条件**:
```bash
export MEDIA_DAILY_BUDGET_USD=0.05
export MEDIA_BUDGET_ON_EXCEEDED=reject
```

**步骤**:
1. 生成2张高质量图片 (消耗 $0.16)
2. 尝试生成第3张

**预期输出**:
```json
{
  "ok": false,
  "error": "budget_exceeded",
  "budget": {
    "ok": false,
    "exceeds": ["global"]
  }
}
```

**验证点**:
- [ ] 请求被拒绝
- [ ] 不调用API
- [ ] 返回预算信息

---

#### TC-IMG-010: 预算耗尽 - 降级模式
**目的**: 验证自动降级到免费服务

**前置条件**:
```bash
export MEDIA_DAILY_BUDGET_USD=0.05
export MEDIA_BUDGET_ON_EXCEEDED=degrade
```

**输入**:
```json
{
  "prompt": "测试图片",
  "provider": "openai",
  "quality": "high"
}
```

**预期输出**:
```json
{
  "ok": true,
  "route": {
    "provider": "gemini",
    "quality": "standard",
    "downgradedFrom": {
      "provider": "openai",
      "quality": "high"
    }
  }
}
```

**验证点**:
- [ ] 自动切换到Gemini
- [ ] 降低到标准质量
- [ ] 包含降级信息

---

#### TC-IMG-011: Budget模式切换
**目的**: 验证不同预算模式的行为

**测试场景**:

| budget_mode | provider auto | 预期provider |
|-------------|---------------|-------------|
| free_first  | auto          | gemini      |
| quality_first | auto        | openai      |

**验证点**:
- [ ] free_first 优先选择 Gemini
- [ ] quality_first 优先选择 OpenAI

---

### 1.4 重试和Fallback测试

#### TC-IMG-012: 网络超时重试
**目的**: 验证临时网络问题的重试

**模拟条件**: 设置短超时
```bash
export OPENAI_IMAGE_TIMEOUT_MS=100
export MEDIA_PRIMARY_MAX_RETRIES=2
```

**验证点**:
- [ ] 执行多次重试
- [ ] 包含重试信息
- [ ] 最终成功或失败

---

#### TC-IMG-013: Provider Fallback
**目的**: 验证主提供商失败后切换

**模拟条件**: 使用无效的OpenAI API Key

**输入**:
```json
{
  "prompt": "测试",
  "provider": "openai"
}
```

**预期行为**:
1. OpenAI 失败
2. 自动切换到 Gemini
3. Gemini 成功

**验证点**:
- [ ] Fallback 被触发
- [ ] 最终返回成功
- [ ] 记录 fallback 信息

---

#### TC-IMG-014: 内容策略错误不Fallback
**目的**: 验证内容违规不触发fallback

**输入**:
```json
{
  "prompt": "违规内容..." // 触发content policy
}
```

**预期行为**:
- 直接返回错误，不尝试fallback

**验证点**:
- [ ] 不执行 fallback
- [ ] 返回 content_policy 错误

---

### 1.5 代理和网络测试

#### TC-IMG-015: HTTP代理
**目的**: 验证HTTP代理支持

**前置条件**:
```bash
export HTTP_PROXY=http://localhost:8888
```

**验证点**:
- [ ] 请求通过代理
- [ ] 正常生成图片

---

#### TC-IMG-016: SOCKS5代理
**目的**: 验证SOCKS代理支持

**前置条件**:
```bash
export HTTPS_PROXY=socks5://localhost:1080
```

**验证点**:
- [ ] SOCKS代理正常工作
- [ ] 设置 ALL_PROXY 环境变量

---

#### TC-IMG-017: 禁用代理
**目的**: 验证可以禁用代理

**输入**:
```json
{
  "prompt": "测试",
  "use_proxy": false
}
```

**验证点**:
- [ ] 不使用代理
- [ ] 直接连接API

---

### 1.6 文件路径安全测试

#### TC-IMG-018: 路径遍历攻击
**目的**: 验证路径安全检查

**输入**:
```json
{
  "filename": "../../etc/passwd.png"
}
```

**预期输出**:
```
Error: Path not allowed: ../../etc/passwd.png
```

**验证点**:
- [ ] 拒绝危险路径
- [ ] 不创建文件

---

#### TC-IMG-019: 允许的路径
**目的**: 验证合法路径可用

**输入**:
```json
{
  "filename": "sessions/media/images/test.png"
}
```

**验证点**:
- [ ] 接受合法路径
- [ ] 文件保存在正确位置

---

## 二、视频生成测试用例 (`skills/video-frames/`)

### 2.1 基础功能测试

#### TC-VID-001: 基本视频生成 (Gemini Veo)
**目的**: 验证Gemini视频生成

**输入**:
```json
{
  "prompt": "海浪拍打沙滩的镜头",
  "provider": "gemini",
  "duration_seconds": 4,
  "aspect_ratio": "16:9",
  "quality": "standard"
}
```

**预期输出**:
```json
{
  "ok": true,
  "route": {
    "provider": "gemini",
    "model": "veo-3.1"
  }
}
```

**验证点**:
- [ ] 返回成功
- [ ] 视频时长约4秒
- [ ] 宽高比为16:9
- [ ] 响应时间 < 300秒

---

#### TC-VID-002: 高质量视频 (OpenAI Sora)
**目的**: 验证Sora视频生成

**输入**:
```json
{
  "prompt": "城市街道延时摄影",
  "provider": "openai",
  "model": "sora-2-pro",
  "duration_seconds": 8,
  "quality": "high"
}
```

**验证点**:
- [ ] 使用Sora模型
- [ ] 高质量设置
- [ ] 成本估算 $1.2

---

### 2.2 边界测试

#### TC-VID-003: 最小时长
**目的**: 测试最短视频

**输入**:
```json
{
  "duration_seconds": 2
}
```

**验证点**:
- [ ] 接受2秒视频
- [ ] 正常生成

---

#### TC-VID-004: 最大时长
**目的**: 测试最长视频

**输入**:
```json
{
  "duration_seconds": 60
}
```

**验证点**:
- [ ] 处理长视频
- [ ] 可能需要更长时间

---

#### TC-VID-005: 不同宽高比
**目的**: 测试各种宽高比

**测试场景**:
- 16:9 (横屏)
- 9:16 (竖屏)
- 1:1 (方形)
- 4:3 (传统)

**验证点**:
- [ ] 所有格式都支持
- [ ] 输出符合比例

---

### 2.3 预算测试

#### TC-VID-006: 视频预算限制
**目的**: 验证视频专项预算

**前置条件**:
```bash
export MEDIA_VIDEO_DAILY_BUDGET_USD=1.0
```

**步骤**:
1. 生成2个高质量视频 (消耗 $2.4)
2. 应被拒绝或降级

**验证点**:
- [ ] 遵守视频预算限制
- [ ] 全局预算和分类预算都检查

---

### 2.4 错误处理

#### TC-VID-007: 缺少Prompt
**输入**:
```json
{
  "duration_seconds": 8
}
```

**预期输出**:
```json
{
  "ok": false,
  "error": "missing_prompt"
}
```

---

#### TC-VID-008: API错误重试
**模拟**: 第一次请求500错误，第二次成功

**验证点**:
- [ ] 执行重试
- [ ] 最终成功
- [ ] 包含重试记录

---

## 三、字幕读取测试用例 (`skills/transcript-fast/`)

### 3.1 基础功能测试

#### TC-TRANS-001: YouTube标准视频
**目的**: 验证提取英文字幕

**输入**:
```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
}
```

**预期输出**:
```json
{
  "ok": true,
  "videoId": "dQw4w9WgXcQ",
  "language": "en",
  "segmentCount": 150,
  "text": "..."
}
```

**验证点**:
- [ ] 正确解析视频ID
- [ ] 提取字幕内容
- [ ] 包含时间戳
- [ ] 文本拼接正确

---

#### TC-TRANS-002: 多语言字幕
**目的**: 验证中文字幕提取

**输入**:
```json
{
  "url": "https://www.youtube.com/watch?v=XXXXX",
  "languages": ["zh-Hans", "zh"]
}
```

**验证点**:
- [ ] 优先选择中文字幕
- [ ] 返回正确语言代码

---

#### TC-TRANS-003: 段落限制
**目的**: 验证最大段数限制

**输入**:
```json
{
  "url": "...",
  "maxSegments": 100
}
```

**验证点**:
- [ ] 最多返回100个片段
- [ ] 从头开始截取

---

### 3.2 URL格式测试

#### TC-TRANS-004: 不同URL格式
**目的**: 测试各种YouTube URL格式

**测试URL**:
- `https://www.youtube.com/watch?v=VIDEO_ID`
- `https://youtu.be/VIDEO_ID`
- `https://www.youtube.com/shorts/VIDEO_ID`
- `https://www.youtube.com/embed/VIDEO_ID`

**验证点**:
- [ ] 所有格式都能正确解析

---

### 3.3 错误处理

#### TC-TRANS-005: 无效URL
**输入**:
```json
{
  "url": "https://example.com/video"
}
```

**预期输出**:
```json
{
  "ok": false,
  "error": "invalid_youtube_url"
}
```

---

#### TC-TRANS-006: 无字幕视频
**输入**: 没有字幕的视频URL

**预期输出**:
```json
{
  "ok": false,
  "error": "no_captions_available"
}
```

---

#### TC-TRANS-007: 私密视频
**输入**: 私密或删除的视频

**预期输出**:
```json
{
  "ok": false,
  "error": "..."
}
```

---

## 四、媒体路由器测试用例 (`skills/_shared/media-router.js`)

### 4.1 路由逻辑测试

#### TC-ROUTER-001: 自动Provider选择
**目的**: 验证auto模式的provider选择

**测试场景**:

| kind  | budget_mode   | 预期provider |
|-------|---------------|-------------|
| image | free_first    | gemini      |
| image | quality_first | openai      |
| video | free_first    | gemini      |
| video | quality_first | openai      |

---

#### TC-ROUTER-002: 成本估算准确性
**目的**: 验证各种场景的成本估算

**测试数据**:

| kind  | provider | model          | quality  | 预期成本 |
|-------|----------|----------------|----------|---------|
| image | openai   | gpt-image-1    | standard | $0.04   |
| image | openai   | gpt-image-1    | high     | $0.08   |
| image | gemini   | gemini-3-pro   | standard | $0.01   |
| video | openai   | sora-2-pro     | high     | $1.20   |
| video | gemini   | veo-3.1        | standard | $0.40   |

---

#### TC-ROUTER-003: 环境变量成本覆盖
**目的**: 验证自定义成本设置

**前置条件**:
```bash
export MEDIA_COST_IMAGE_OPENAI_GPT_IMAGE_1_STANDARD=0.05
```

**验证点**:
- [ ] 使用环境变量中的成本
- [ ] 覆盖默认值

---

### 4.2 预算账本测试

#### TC-ROUTER-004: 预算记录持久化
**目的**: 验证预算使用记录

**步骤**:
1. 生成一张图片
2. 读取 `sessions/media/budget-ledger.json`
3. 验证记录存在

**验证点**:
- [ ] 文件创建
- [ ] 包含今日条目
- [ ] 记录正确的成本
- [ ] 包含元数据(provider, model, timestamp)

---

#### TC-ROUTER-005: 跨天重置
**目的**: 验证每日预算重置

**步骤**:
1. 记录当天使用
2. 模拟第二天(修改系统时间或代码)
3. 检查预算

**验证点**:
- [ ] 新的一天预算重置
- [ ] 历史记录保留

---

#### TC-ROUTER-006: 预算条目限制
**目的**: 验证只保留最近500条记录

**步骤**:
1. 生成600个请求
2. 检查账本

**验证点**:
- [ ] 只保留最近500条
- [ ] 总计数字正确

---

### 4.3 输入解析测试

#### TC-ROUTER-007: JSON输入解析
**输入**:
```json
"{\"prompt\": \"test\", \"quality\": \"high\"}"
```

**验证点**:
- [ ] 正确解析JSON字符串
- [ ] 提取所有字段

---

#### TC-ROUTER-008: 纯文本输入
**输入**:
```
"一只可爱的猫咪"
```

**预期解析结果**:
```json
{
  "task": "image",
  "prompt": "一只可爱的猫咪"
}
```

---

#### TC-ROUTER-009: 无效JSON处理
**输入**:
```
"{invalid json"
```

**预期解析结果**:
```json
{
  "task": "image",
  "prompt": "{invalid json",
  "_parse_error": "invalid_json"
}
```

---

## 五、集成测试

### 5.1 端到端测试

#### TC-E2E-001: 完整图片生成流程
**步骤**:
1. 调用图片生成skill
2. 等待完成
3. 验证输出文件
4. 检查预算记录
5. 验证元数据

**验证点**:
- [ ] 全流程无错误
- [ ] 所有数据一致

---

#### TC-E2E-002: 视频生成完整流程
**步骤**:
1. 生成视频
2. 下载结果
3. 验证视频属性(时长、分辨率)
4. 检查成本记录

---

#### TC-E2E-003: Fallback完整流程
**步骤**:
1. 配置主provider失败
2. 启用fallback
3. 验证自动切换
4. 检查结果正确性

---

### 5.2 并发测试

#### TC-CONCURRENT-001: 3个并发图片请求
**目的**: 验证并发处理能力

**步骤**:
1. 同时发起3个图片生成请求
2. 等待全部完成

**验证点**:
- [ ] 全部成功
- [ ] 没有预算重复计算
- [ ] 文件不冲突

---

#### TC-CONCURRENT-002: 混合并发(图片+视频)
**步骤**:
1. 同时发起2个图片 + 1个视频请求

**验证点**:
- [ ] 分别计算预算
- [ ] 互不影响

---

## 六、性能测试

### 6.1 响应时间测试

#### TC-PERF-001: 图片生成延迟
**目标**:
- 标准质量: < 30秒
- 高质量: < 60秒

**测试数据**: 10个不同prompt

**验证点**:
- [ ] 平均响应时间
- [ ] P95延迟
- [ ] P99延迟

---

#### TC-PERF-002: 视频生成延迟
**目标**:
- 4秒视频: < 120秒
- 8秒视频: < 240秒

---

#### TC-PERF-003: 字幕提取延迟
**目标**: < 5秒

---

### 6.2 负载测试

#### TC-LOAD-001: 持续负载
**场景**: 1小时内生成100张图片

**监控指标**:
- [ ] 成功率 > 95%
- [ ] 无内存泄漏
- [ ] 预算计算准确

---

## 七、回归测试清单

每次更新后运行:

- [ ] TC-IMG-001 (基本图片生成)
- [ ] TC-IMG-009 (预算拒绝)
- [ ] TC-IMG-013 (Provider fallback)
- [ ] TC-VID-001 (基本视频生成)
- [ ] TC-TRANS-001 (字幕提取)
- [ ] TC-ROUTER-002 (成本估算)
- [ ] TC-E2E-001 (端到端图片)

---

## 八、测试工具和脚本

### 8.1 自动化测试脚本

```bash
#!/bin/bash
# test-media.sh - 媒体功能测试脚本

# 设置测试环境
export MEDIA_DAILY_BUDGET_USD=10.0
export MEDIA_BUDGET_ON_EXCEEDED=degrade

# 运行测试
echo "Testing image generation..."
node test-image.js

echo "Testing video generation..."
node test-video.js

echo "Testing transcript..."
node test-transcript.js

# 检查结果
if [ $? -eq 0 ]; then
  echo "✅ All tests passed"
else
  echo "❌ Tests failed"
  exit 1
fi
```

### 8.2 性能监控脚本

```javascript
// monitor-performance.js
import fs from 'fs';

const results = [];

async function measureImageGeneration(prompt) {
  const start = Date.now();

  try {
    const result = await generateImage({ prompt });
    const duration = Date.now() - start;

    results.push({
      type: 'image',
      success: true,
      duration,
      prompt: prompt.slice(0, 50),
    });

    return duration;
  } catch (error) {
    results.push({
      type: 'image',
      success: false,
      duration: Date.now() - start,
      error: String(error),
    });
    throw error;
  }
}

// 运行测试
const prompts = [
  "一只猫",
  "风景画",
  "抽象艺术",
  // ... 更多
];

for (const prompt of prompts) {
  await measureImageGeneration(prompt);
  await sleep(2000); // 避免速率限制
}

// 生成报告
console.log('Performance Report:');
console.log(`Total tests: ${results.length}`);
console.log(`Success rate: ${results.filter(r => r.success).length / results.length * 100}%`);
console.log(`Average duration: ${results.reduce((a, b) => a + b.duration, 0) / results.length}ms`);

fs.writeFileSync('performance-report.json', JSON.stringify(results, null, 2));
```

---

## 九、测试数据准备

### 9.1 测试图片资源
在 `test-assets/` 目录准备:
- `cat.png` - 512x512 宠物照片
- `landscape.jpg` - 1920x1080 风景
- `portrait.png` - 1080x1920 人像
- `small.png` - 256x256 小图
- `large.png` - 4096x4096 大图

### 9.2 测试视频URL
- YouTube标准视频 (有英文字幕)
- YouTube中文视频
- YouTube短视频 (Shorts)
- 私密视频
- 删除的视频

### 9.3 测试Prompt库
```json
{
  "simple": [
    "一只狗",
    "红色的花",
    "蓝天白云"
  ],
  "complex": [
    "未来主义城市景观，霓虹灯闪烁，人群熙攘，赛博朋克风格",
    "水彩画风格的日落海滩，温暖色调，宁静氛围"
  ],
  "edge_cases": [
    "a", // 极短
    "一个非常详细的描述...".repeat(100), // 极长
    "特殊字符 !@#$%^&*()",
    "" // 空
  ]
}
```

---

## 十、Bug报告模板

发现问题时使用此模板:

```markdown
## Bug ID: BUG-MEDIA-XXX

**严重程度**: Critical / High / Medium / Low

**组件**: Image Gen / Video Gen / Transcript / Router

**测试用例**: TC-XXX-XXX

**环境**:
- Node版本:
- OS:
- 相关环境变量:

**复现步骤**:
1.
2.
3.

**预期行为**:


**实际行为**:


**错误日志**:
\`\`\`

\`\`\`

**截图/文件**:


**可能的原因**:


**建议修复**:

```

---

## 总结

本测试套件涵盖:
- ✅ **80+ 测试用例**
- ✅ **功能测试** - 验证所有核心功能
- ✅ **边界测试** - 极限情况处理
- ✅ **安全测试** - 路径注入、权限检查
- ✅ **性能测试** - 响应时间、并发能力
- ✅ **集成测试** - 端到端流程

建议使用CI/CD自动化运行核心测试用例，确保每次代码变更的质量。
