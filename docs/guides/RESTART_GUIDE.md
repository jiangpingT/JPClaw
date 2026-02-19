# JPClaw 系统重启指南

## 快速重启

### 标准重启流程
```bash
# 1. 进入项目目录
cd /Users/mlamp/Workspace/JPClaw

# 2. 停止现有进程（如果在运行）
pkill -f "node.*gateway" || pkill -f "npm.*start" || true

# 3. 安装/更新依赖
npm install

# 4. 运行类型检查
npm run typecheck

# 5. 运行测试（可选）
npm test

# 6. 启动系统
npm start
```

### 开发模式重启
```bash
# 开发模式（支持热重载）
npm run dev
```

## 系统健康检查

### 启动前检查
```bash
# 1. 检查 Node.js 版本
node --version  # 需要 >= 18.x

# 2. 检查环境变量
echo "检查 Discord Token: ${DISCORD_TOKEN:0:10}..."
echo "检查 OpenAI Key: ${OPENAI_API_KEY:0:10}..."

# 3. 检查端口占用
lsof -i :3000  # 检查默认端口

# 4. 检查目录权限
ls -la log/  # 确保日志目录可写
```

### 启动后验证
```bash
# 1. 检查进程状态
ps aux | grep -E "(node|gateway)"

# 2. 检查健康端点
curl -s http://localhost:3000/health | jq

# 3. 检查日志
tail -f log/gateway.log

# 4. 验证 Discord 连接
curl -s http://localhost:3000/api/channels/discord/status | jq
```

## 故障排除

### 常见问题和解决方案

#### 1. 端口被占用
```bash
# 查找占用端口的进程
lsof -i :3000

# 强制终止进程
kill -9 <PID>

# 或使用不同端口启动
PORT=3001 npm start
```

#### 2. Discord 连接失败
```bash
# 检查 Discord Token
echo $DISCORD_TOKEN

# 检查网络连接
ping discord.com

# 查看 Discord 特定日志
grep -i discord log/gateway.log | tail -20
```

#### 3. 内存不足
```bash
# 检查内存使用
free -h

# 增加 Node.js 内存限制
NODE_OPTIONS="--max-old-space-size=4096" npm start
```

#### 4. 依赖问题
```bash
# 清理并重新安装
rm -rf node_modules package-lock.json
npm install

# 检查依赖冲突
npm ls --depth=0
```

## 配置验证

### 环境变量检查清单
- [ ] `DISCORD_TOKEN` - Discord Bot Token
- [ ] `OPENAI_API_KEY` - OpenAI API Key  
- [ ] `JPCLAW_OWNER_DISCORD_ID` - 管理员 Discord ID
- [ ] `PORT` - 服务端口（默认3000）
- [ ] `NODE_ENV` - 环境类型（development/production）

### 配置文件检查
```bash
# 检查主配置
cat config/config.json | jq

# 检查 Discord 配置
cat config/channels/discord.json | jq

# 检查技能配置
ls -la skills/
```

## 监控和日志

### 实时监控
```bash
# 查看实时日志
tail -f log/gateway.log

# 过滤特定组件日志
tail -f log/gateway.log | grep -E "(discord|error|warn)"

# 监控系统资源
watch -n 1 'ps aux | grep node | head -10'
```

### 性能指标
```bash
# 查看性能指标
curl -s http://localhost:3000/api/monitoring/metrics | jq

# 查看健康状态
curl -s http://localhost:3000/health | jq '.status'

# Discord 特定指标
curl -s http://localhost:3000/api/channels/discord/metrics | jq
```

## 备份和恢复

### 数据备份
```bash
# 备份配置文件
cp -r config config-backup-$(date +%Y%m%d)

# 备份日志
cp -r log log-backup-$(date +%Y%m%d)

# 备份技能数据
cp -r skills skills-backup-$(date +%Y%m%d)
```

### 快速恢复
```bash
# 恢复配置
cp -r config-backup-20240214/* config/

# 重置到最后已知工作状态
git status
git stash  # 保存当前更改
git reset --hard HEAD~1  # 回到上一个提交
```

## 升级和维护

### 系统更新
```bash
# 1. 备份当前版本
cp -r /Users/mlamp/Workspace/JPClaw /Users/mlamp/Workspace/JPClaw-backup

# 2. 拉取最新代码
git pull origin main

# 3. 更新依赖
npm install

# 4. 运行迁移脚本（如果需要）
npm run migrate

# 5. 重启系统
npm restart
```

### 定期维护
```bash
# 每日维护任务
npm run cleanup  # 清理日志和临时文件
npm run health-check  # 运行健康检查

# 每周维护
npm audit  # 检查安全漏洞
npm outdated  # 检查过时依赖
```

## 紧急联系

### 系统管理员
- **姜哥**：系统所有者，处理重大问题
- **日志位置**：`/Users/mlamp/Workspace/JPClaw/log/`
- **配置位置**：`/Users/mlamp/Workspace/JPClaw/config/`

### 常用命令速查
```bash
# 完整重启
npm run restart

# 强制重启
npm run force-restart

# 检查状态
npm run status

# 查看日志
npm run logs

# 运行测试
npm test
```

---

**重要提醒**：
1. 重启前确保保存所有重要数据
2. 在生产环境中重启前先在测试环境验证
3. 重启后验证所有核心功能是否正常
4. 保持监控日志以便及时发现问题