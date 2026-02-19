# JPClaw 技能路由测试清单
**生成时间**: 2026-02-15

## 🎯 测试说明

请将以下查询**直接发送给正在运行的JPClaw**（通过Discord/Web/CLI），观察是否正确触发技能。

---

## ⭐ 第一组：核心功能（必测10个）

### 1. web-search
```
搜索一下今天的科技新闻
```
**期望**: 调用 web-search 技能，返回新闻搜索结果
**结果**: ⬜ 通过 ⬜ 失败

---

### 2. map-poi
```
附近有什么咖啡馆
```
**期望**: 调用 map-poi 技能，查询附近POI
**结果**: ⬜ 通过 ⬜ 失败

---

### 3. weather
```
查询北京的天气
```
**期望**: 调用 weather 技能，返回天气信息
**结果**: ⬜ 通过 ⬜ 失败

---

### 4. openai-image-gen
```
生成一张未来城市的图片
```
**期望**: 调用 openai-image-gen 技能
**结果**: ⬜ 通过 ⬜ 失败

---

### 5. browser-automation
```
打开网页 https://github.com 并截图
```
**期望**: 调用 browser-automation 技能
**结果**: ⬜ 通过 ⬜ 失败

---

### 6. github
```
查看最新的GitHub PR
```
**期望**: 调用 github 技能，使用 gh CLI
**结果**: ⬜ 通过 ⬜ 失败

---

### 7. coding-agent
```
用Codex帮我重构这段代码
```
**期望**: 调用 coding-agent 技能
**结果**: ⬜ 通过 ⬜ 失败

---

### 8. doc-generation
```
生成一份项目报告文档
```
**期望**: 调用 doc-generation 技能
**结果**: ⬜ 通过 ⬜ 失败

---

### 9. email-automation
```
草拟一封邮件给客户
```
**期望**: 调用 email-automation 技能
**结果**: ⬜ 通过 ⬜ 失败

---

### 10. data-analysis
```
分析这个CSV文件
```
**期望**: 调用 data-analysis 技能
**结果**: ⬜ 通过 ⬜ 失败

---

## 📊 第二组：常用功能（建议测试10个）

### 11. web-scraper
```
抓取 https://news.ycombinator.com 的标题
```

### 12. video-frames
```
生成一个城市日出的视频
```

### 13. transcript-fast
```
获取YouTube视频的字幕
```

### 14. notion
```
在Notion创建一个新页面
```

### 15. discord
```
发送Discord消息到开发频道
```

### 16. apple-notes
```
添加一条备忘录：明天买牛奶
```

### 17. design-doc-mermaid
```
生成一个用户登录流程的时序图
```

### 18. api-integration
```
调用这个API接口获取数据
```

### 19. insight-summary
```
提取这段文本的关键要点
```

### 20. map-share-links
```
生成北京天安门的地图分享链接
```

---

## 🔧 第三组：专业工具（可选测试）

### 21-30. 其他技能
```
监控即刻主页数据 (jike-monitor)
在Bear创建一个新笔记 (bear-notes)
查看今天的提醒事项 (apple-reminders)
从1Password读取密码 (1password)
用Gemini回答问题 (gemini)
搜索附近的寿司店 (goplaces)
发送iMessage给朋友 (bluebubbles)
转录音频文件 (audio-stt)
朗读这段文字 (audio-tts)
在Spotify播放歌单 (spotify-player)
```

---

## 📝 如何判断测试通过？

### ✅ 通过标志
1. **JPClaw响应中提到了技能名称**: "正在调用 web-search..."
2. **直接返回技能执行结果**: 返回搜索结果、图片、数据等
3. **日志中显示路由成功**: 查看 `log/gateway.log`

### ❌ 失败标志
1. **JPClaw用AI直接回复**: 没有调用技能，只是用模型回答
2. **调用了错误的技能**: 期望 map-poi，实际调用了 goplaces
3. **提示找不到技能**: 路由失败

---

## 🔍 查看路由日志

测试时同时运行：
```bash
tail -f /Users/mlamp/Workspace/JPClaw/log/gateway.log | grep -E "skill_router|run_skill"
```

成功的日志示例：
```
skill_router.selected: { name: 'web-search', confidence: 0.95, reason: '...' }
```

---

## 📊 测试结果统计

完成测试后，请统计：

- ✅ **通过**: ___/30
- ❌ **失败**: ___/30
- 📈 **通过率**: ___%

### 按优先级统计
- 核心功能 (1-10): ___/10
- 常用功能 (11-20): ___/10
- 专业工具 (21-30): ___/10

---

## 💡 测试建议

1. **一次测试一个**: 逐个发送查询，观察结果
2. **记录失败案例**: 注明期望技能和实际结果
3. **观察置信度**: 从日志中查看路由置信度
4. **测试边界情况**: 模糊查询、相似技能竞争

---

## 🎯 成功标准

- **核心功能**: ≥ 90% 通过率
- **常用功能**: ≥ 80% 通过率
- **整体通过率**: ≥ 85%

---

**开始测试吧！** 🚀
