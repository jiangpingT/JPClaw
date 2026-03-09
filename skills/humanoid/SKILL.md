---
name: humanoid
description: 人形机器人运动控制。当用户提到"人形机器人"或"人形"并描述一个动作时触发，例如"让人形机器人跑步"、"人形机器人向前走"、"人形机器人向左走"、"人形左转"、"让人形机器人后退"、"让人形跑起来"。生成人形机器人仿真动画 GIF 并发送给用户。支持跑步（高速腾空）、前进、后退、左移、右移、左转、右转。使用 SAC 强化学习模型驱动，基于 Gymnasium Humanoid-v4 + 速度命令追踪。
---

# Humanoid Robot Control

## Purpose
控制 JPRobot 人形机器人执行运动，返回动画 GIF。

## Trigger
- 用户消息中包含"人形机器人"、"人形"或"humanoid"，且描述了动作
- 示例：
  - "让人形机器人跑步"
  - "人形机器人跑起来"
  - "让人形跑"
  - "让人形机器人向前走"
  - "人形机器人向左走"
  - "人形左转"
  - "让人形机器人后退"
  - "人形机器人右转"
  - "humanoid run"
  - "humanoid walk forward"

## Input
将用户的原始消息直接传给技能，技能内部解析动作并确保含"人形"关键词。

## Output
返回特殊 JSON 标记（由 bot handler 拦截发送 GIF，不直接展示给用户）：
```json
{"type":"robot_gif","filePath":"/tmp/humanoid-xxx.gif","command":"人形机器人跑步"}
```

## Supported Actions
- **跑步 / 奔跑 / 跑起来 / 快跑**（高速 vx=1.5m/s，含腾空相，专用跑步模型）
- 向前走（默认，vx=0.8）
- 向左走 / 左移（vy=+0.4）
- 向右走 / 右移（vy=-0.4）
- 后退（vx=-0.5）
- 左转（wz=+0.6）
- 右转（wz=-0.6）
