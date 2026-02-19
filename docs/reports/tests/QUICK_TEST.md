# JPClaw 技能路由快速测试清单

## 🎯 测试方法

向JPClaw发送以下查询，验证是否路由到正确的技能。

## ⭐ 高优先级技能（必测）

### 1. web-search
**查询**: `搜索一下今天的科技新闻`
**期望**: 应该调用 web-search 技能
**验证**: 返回新闻搜索结果

---

### 2. map-poi
**查询**: `附近有什么咖啡馆`
**期望**: 应该调用 map-poi 技能
**验证**: 返回附近咖啡馆列表（需要高德API配置）

---

### 3. weather
**查询**: `查询北京的天气`
**期望**: 应该调用 weather 技能
**验证**: 返回天气信息

---

### 4. openai-image-gen
**查询**: `生成一张未来城市的图片`
**期望**: 应该调用 openai-image-gen 技能
**验证**: 生成图片或提示需要API配置

---

### 5. browser-automation
**查询**: `打开网页 https://github.com 并截图`
**期望**: 应该调用 browser-automation 技能
**验证**: 打开浏览器并截图

---

### 6. github
**查询**: `查看最新的GitHub PR`
**期望**: 应该调用 github 技能
**验证**: 使用 gh CLI 查看PR

---

## 📊 中优先级技能（推荐测试）

### 7. doc-generation
**查询**: `生成一份项目报告文档`
**期望**: doc-generation

### 8. email-automation
**查询**: `草拟一封邮件给客户`
**期望**: email-automation

### 9. data-analysis
**查询**: `分析这个CSV文件`
**期望**: data-analysis

### 10. transcript-fast
**查询**: `获取YouTube视频字幕`
**期望**: transcript-fast

---

## 🔍 特殊场景测试

### 技能名称出现在查询中
**查询**: `用Notion创建一个页面`
**期望**: notion 技能（名称明确）

### 模糊查询
**查询**: `帮我找一下餐厅`
**期望**: map-poi 或 goplaces（需要看路由倾向）

### 多技能竞争
**查询**: `搜索附近的寿司店`
**期望**: goplaces (Google Places) 或 map-poi (高德地图)
**分析**: 两个技能功能相似，测试路由选择

---

## 📝 测试记录模板

| # | 查询 | 期望技能 | 实际技能 | 置信度 | 结果 |
|---|------|---------|---------|--------|------|
| 1 | 搜索一下今天的科技新闻 | web-search | ? | ? | ⏳ |
| 2 | 附近有什么咖啡馆 | map-poi | ? | ? | ⏳ |
| 3 | 查询北京的天气 | weather | ? | ? | ⏳ |
| 4 | 生成一张未来城市的图片 | openai-image-gen | ? | ? | ⏳ |
| 5 | 打开网页并截图 | browser-automation | ? | ? | ⏳ |

---

## 🔧 如何查看路由结果

### 方法1: 查看日志
```bash
tail -f /Users/mlamp/Workspace/JPClaw/log/gateway.log | grep -E "skill_router|selected"
```

### 方法2: 观察JPClaw响应
- 如果技能被路由，JPClaw会直接执行该技能
- 如果未路由，JPClaw会用 AI 模型直接回复

### 方法3: 查看日志中的路由决策
日志中会显示:
```
skill_router.selected: { name: 'web-search', confidence: 0.95, reason: '...' }
```

---

## ✅ 成功标准

- **高优先级技能**: 100% 路由成功
- **中优先级技能**: > 80% 路由成功
- **整体通过率**: > 90%
- **平均置信度**: > 0.75

---

## 💡 测试技巧

1. **先测简单的**: 从明确的查询开始（如"搜索XX"）
2. **观察置信度**: 高置信度（>0.9）说明描述效果好
3. **测试边界情况**: 模糊查询、多技能竞争
4. **记录失败案例**: 用于后续优化description

---

## 🚀 开始测试！

直接向JPClaw发送上面的查询，观察路由结果即可。

祝测试顺利！🎉
