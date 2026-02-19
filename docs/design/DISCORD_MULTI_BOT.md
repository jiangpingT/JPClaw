# Discord 多机器人配置指南

JPClaw 现在支持在单个进程中运行多个 Discord 机器人！

## 环境变量配置

在 `.env` 文件中配置多个机器人：

```bash
# 第一个机器人
DISCORD_BOT1_TOKEN=你的第一个bot的token
DISCORD_BOT1_NAME=bot1
DISCORD_BOT1_CHANNELS=1469204772379693222

# 第二个机器人
DISCORD_BOT2_TOKEN=你的第二个bot的token
DISCORD_BOT2_NAME=bot2
DISCORD_BOT2_CHANNELS=1469204772379693223

# 第三个机器人（可选）
DISCORD_BOT3_TOKEN=你的第三个bot的token
DISCORD_BOT3_NAME=bot3
DISCORD_BOT3_CHANNELS=channel_id_1,channel_id_2,channel_id_3
```

### 配置说明

- **DISCORD_BOTx_TOKEN**：必填，机器人的访问令牌
- **DISCORD_BOTx_NAME**：可选，机器人名称（用于日志和调试）
- **DISCORD_BOTx_CHANNELS**：可选，监听的频道 ID 列表（逗号分隔）

编号必须从 1 开始连续递增（1, 2, 3...）。

## JSON 配置文件（高级）

你也可以在 `sessions/jpclaw.json` 中直接配置：

```json
{
  "providers": [
    {
      "type": "anthropic",
      "apiKey": "your-api-key"
    }
  ],
  "channels": {
    "discord": [
      {
        "enabled": true,
        "token": "第一个bot的token",
        "name": "bot1",
        "channels": ["1469204772379693222"]
      },
      {
        "enabled": true,
        "token": "第二个bot的token",
        "name": "bot2",
        "channels": ["1469204772379693223"]
      }
    ]
  },
  "gateway": {
    "host": "127.0.0.1",
    "port": 18790
  }
}
```

## 向后兼容

如果你只需要一个机器人，旧的配置方式仍然有效：

```bash
DISCORD_BOT_TOKEN=你的bot令牌
```

## 如何创建 Discord Bot

1. 访问 [Discord Developer Portal](https://discord.com/developers/applications)
2. 点击 "New Application"
3. 给你的应用命名，点击 "Create"
4. 在左侧菜单选择 "Bot"
5. 点击 "Add Bot" 确认创建
6. 在 Token 部分点击 "Copy" 复制 token

### 邀请 Bot 到服务器

1. 在左侧菜单选择 "OAuth2" -> "URL Generator"
2. 在 SCOPES 中勾选 `bot`
3. 在 BOT PERMISSIONS 中勾选：
   - Read Messages/View Channels
   - Send Messages
   - Read Message History
   - Attach Files
4. 复制生成的 URL 在浏览器中打开
5. 选择你的服务器并授权

### 获取 Channel ID

1. 在 Discord 中，进入 "用户设置" -> "高级"
2. 开启 "开发者模式"
3. 右键点击频道 -> "复制频道 ID"

## 启动和测试

1. 配置好环境变量后，重启 gateway：
   ```bash
   npm run restart
   ```

2. 检查健康状态：
   ```bash
   curl http://localhost:18790/health | jq '.discord'
   ```

3. 查看日志确认所有 bot 都已启动：
   ```bash
   npm run logs
   ```

## ⚠️ 安全提醒

**永远不要公开分享你的 bot token！**

如果你的 token 泄露了：
1. 立即前往 Discord Developer Portal
2. 选择对应的应用
3. 进入 Bot 设置页面
4. 点击 "Reset Token" 重置令牌
5. 更新 `.env` 文件中的新 token
