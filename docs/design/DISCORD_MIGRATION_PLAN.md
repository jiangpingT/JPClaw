# Discord 模块迁移计划

## 当前状态
- **原有文件**: `src/js/channels/discord-legacy.ts` (2486行，完整功能)
- **新增文件**: `src/js/channels/enhanced-discord-processor.ts` (性能优化)
- **主模块**: `src/js/channels/discord.ts` (集成模块，新的入口点)

## 迁移策略

### 第一阶段：渐进式集成（推荐）

1. **保持原有文件不变**
   - `discord.ts` 继续提供完整功能
   - 所有现有业务逻辑保持运行
   - 不会破坏现有功能

2. **使用集成模块**
   ```typescript
   // 在 gateway/index.ts 中
   import { startDiscordChannel } from "./channels/discord-integration.js";
   // 替换原有的
   // import { startDiscordChannel } from "./channels/discord.js";
   ```

3. **监控性能提升**
   - 新的监控指标会显示性能改进
   - 可以对比优化前后的表现

### 第二阶段：逐步迁移功能

1. **将原有功能模块化**
   ```typescript
   // 创建独立的功能模块
   - src/js/channels/handlers/moltbook-handler.ts
   - src/js/channels/handlers/local-ops-handler.ts
   - src/js/channels/handlers/admin-handler.ts
   ```

2. **保持 API 兼容性**
   - 所有现有的函数签名保持不变
   - 用户感知不到内部变化

## 文件处理方案

### 选项 1：渐进式迁移（推荐）
```bash
# 1. 重命名原文件为备份
mv src/js/channels/discord.ts src/js/channels/discord-legacy.ts

# 2. 使用集成模块作为新的 discord.ts
cp src/js/channels/discord-integration.ts src/js/channels/discord.ts

# 3. 更新导入引用
# discord-integration.ts 内部会导入 discord-legacy.ts
```

### 选项 2：并行运行
```bash
# 保持两个文件并存
# 在配置中选择使用哪个版本
# 可以通过环境变量控制：USE_ENHANCED_DISCORD=true
```

### 选项 3：完整替换（高风险）
```bash
# 直接用新的增强处理器替换
# 需要重新实现所有原有功能
# 不推荐，风险太大
```

## 推荐的迁移步骤

### 步骤 1：备份和准备
```bash
# 1. 备份原有文件
cp src/js/channels/discord.ts src/js/channels/discord-backup-$(date +%Y%m%d).ts

# 2. 确保所有依赖安装完成
npm install
```

### 步骤 2：更新 gateway 引用
```typescript
// 在 src/js/gateway/index.ts 中
import { startDiscordChannel } from "../channels/discord-integration.js";
// 而不是
// import { startDiscordChannel } from "../channels/discord.js";
```

### 步骤 3：测试验证
```bash
# 运行测试确保功能正常
npm test

# 启动服务验证 Discord 功能
npm start
```

### 步骤 4：监控观察
- 观察新的性能指标
- 确认所有功能正常工作
- 检查错误日志

## 回滚计划
如果出现问题，可以快速回滚：

```bash
# 1. 恢复原有的引用
# 在 gateway/index.ts 中改回
import { startDiscordChannel } from "../channels/discord.js";

# 2. 重启服务
npm restart
```

## 注意事项
1. **功能完整性**：原有的所有业务逻辑都会保持
2. **性能提升**：新架构提供更好的错误处理和监控
3. **向后兼容**：API 接口保持完全一致
4. **监控能力**：增加了详细的性能和错误监控

## 验证清单
- [ ] Discord 连接正常
- [ ] 消息处理正常
- [ ] 管理员命令可用
- [ ] Moltbook 功能正常
- [ ] 本地操作功能正常
- [ ] 错误处理正确
- [ ] 性能监控数据正常