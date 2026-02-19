# JPClaw Service Manager

统一管理JPClaw Gateway服务（支持launchd和手动模式）

## 快速使用

```bash
# 查看服务状态
npm run status

# 重启服务（推荐）
npm run restart

# 停止服务
npm run stop

# 查看日志
npm run logs

# 手动启动（前台运行，用于调试）
npm run manual
```

## 详细说明

### 1. 查看状态 (`status`)

```bash
npm run status
```

显示：
- launchd服务状态
- 端口18790占用情况
- 手动启动的进程

### 2. 重启服务 (`restart`)

```bash
npm run restart
```

**这是最推荐的命令！** 会自动：
1. 停止launchd服务
2. 清理所有相关进程
3. 等待端口释放
4. 重新启动服务

**使用场景：**
- 代码更新后需要重启
- 服务异常需要重启
- 配置修改后生效

### 3. 停止服务 (`stop`)

```bash
npm run stop
```

完全停止所有gateway相关服务和进程。

### 4. 查看日志 (`logs`)

```bash
npm run logs
```

实时查看gateway日志（Ctrl+C退出）。

### 5. 手动模式 (`manual`)

```bash
npm run manual
```

在前台运行gateway，用于调试。会自动停止launchd服务以避免冲突。

## 技术细节

### 为什么需要这个管理器？

**问题：** 原来的 `npm run stop` 只kill进程，但launchd配置了 `KeepAlive: true`，导致：
- kill进程 → launchd自动重启 → 端口继续被占用 → 无限循环

**解决方案：** 新的service-manager会：
1. 先停止launchd服务
2. 再清理进程
3. 验证端口释放
4. 确保完全停止

### 服务模式

JPClaw支持两种运行模式：

**1. launchd模式（生产环境）**
- 自动启动（系统重启后）
- 崩溃自动重启
- 后台运行
- 日志写入文件

**2. 手动模式（开发调试）**
- 前台运行
- 直接看到输出
- 便于调试
- Ctrl+C停止

### 配置文件

```
~/Library/LaunchAgents/com.jpclaw.gateway.plist
```

## 常见问题

### Q: 重启后还是端口占用？

```bash
# 强制清理
./scripts/service-manager.sh stop
sleep 5
./scripts/service-manager.sh status  # 确认已停止
./scripts/service-manager.sh start
```

### Q: 如何切换到launchd自动启动？

launchd配置已存在，执行：
```bash
launchctl load ~/Library/LaunchAgents/com.jpclaw.gateway.plist
launchctl start com.jpclaw.gateway
```

### Q: 如何完全禁用launchd自动启动？

```bash
launchctl unload ~/Library/LaunchAgents/com.jpclaw.gateway.plist
```

## 最佳实践

**日常开发：**
```bash
npm run manual  # 前台运行，便于调试
```

**生产部署：**
```bash
npm run restart  # 使用launchd，自动重启
```

**排查问题：**
```bash
npm run status   # 查看状态
npm run logs     # 查看日志
```

## 升级checklist

代码更新后重启服务：

```bash
# 1. 编译
npm run build

# 2. 重启（自动停止旧版本）
npm run restart

# 3. 验证
npm run status

# 4. 查看日志确认启动成功
npm run logs
```
