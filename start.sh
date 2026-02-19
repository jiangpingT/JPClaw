#!/bin/bash

# JPClaw启动脚本 - 禁用代理避免冲突

# 清除代理环境变量
unset http_proxy
unset https_proxy
unset all_proxy
unset HTTP_PROXY
unset HTTPS_PROXY
unset ALL_PROXY

# 启动JPClaw
cd "$(dirname "$0")"
npm start
