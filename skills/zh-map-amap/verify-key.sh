#!/bin/bash

echo "🔍 验证 AMAP_API_KEY 配置"
echo "======================================"
echo ""

# 检查环境变量
if [ -z "$AMAP_API_KEY" ]; then
    echo "❌ 当前会话未检测到 AMAP_API_KEY"
    echo ""
    echo "请运行以下命令之一："
    echo "  1. source ~/.zshrc        # 重新加载配置"
    echo "  2. 重启终端"
    echo "  3. export AMAP_API_KEY=\"你的Key\"  # 临时设置"
    echo ""
    exit 1
else
    echo "✅ 环境变量已设置"
    echo "Key: ${AMAP_API_KEY:0:10}...${AMAP_API_KEY: -4}"
    echo ""
fi

# 检查配置文件
if grep -q "AMAP_API_KEY" ~/.zshrc 2>/dev/null; then
    echo "✅ ~/.zshrc 中已配置（永久生效）"
    grep "AMAP_API_KEY" ~/.zshrc | head -1
else
    echo "⚠️  ~/.zshrc 中未找到配置"
fi

echo ""

# 测试API Key是否有效
echo "🌐 测试API Key有效性..."
response=$(curl -s "https://restapi.amap.com/v3/ip?key=$AMAP_API_KEY")

if echo "$response" | grep -q '"status":"1"'; then
    echo "✅ API Key有效！"
    echo ""
    echo "API返回数据示例："
    echo "$response" | head -c 200
    echo "..."
else
    echo "❌ API Key可能无效"
    echo "响应："
    echo "$response"
fi

echo ""
echo "======================================"
echo "✨ 验证完成"
