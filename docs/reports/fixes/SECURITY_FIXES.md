# JPClaw 安全修复清单

## 🔴 紧急安全问题

### 1. 硬编码用户ID泄露
**文件**: `src/js/channels/discord.ts:60`, `src/js/pi/engine.ts:75`
**风险**: 真实Discord ID暴露
**修复**:
```bash
# 添加到 .env
JPCLAW_OWNER_DISCORD_ID=1351911386602672133

# 从代码中移除硬编码
```

### 2. 内存泄漏Map
**文件**: `src/js/channels/discord.ts:70-79`
**风险**: 长期运行内存溢出
**修复**: 添加定时清理机制

### 3. 错误处理不完善
**文件**: 多处catch语句
**风险**: 静默失败
**修复**: 添加降级策略

## 修复优先级
1. 移除硬编码ID ⚠️
2. 修复内存泄漏 📈
3. 完善错误处理 🛡️