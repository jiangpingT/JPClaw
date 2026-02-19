#!/bin/bash

# JPClaw 技能重命名脚本
# 用法: ./rename-skill.sh <旧名称> <新名称>

set -e  # 遇到错误立即退出

OLD_NAME=$1
NEW_NAME=$2

if [ -z "$OLD_NAME" ] || [ -z "$NEW_NAME" ]; then
    echo "用法: ./rename-skill.sh <旧名称> <新名称>"
    echo "示例: ./rename-skill.sh map-poi zh-map-amap"
    exit 1
fi

echo "════════════════════════════════════════════════════════════"
echo "技能重命名: $OLD_NAME → $NEW_NAME"
echo "════════════════════════════════════════════════════════════"
echo ""

# 检查旧技能是否存在
if [ ! -d "skills/$OLD_NAME" ]; then
    echo "❌ 错误: 技能 $OLD_NAME 不存在！"
    exit 1
fi

# 检查新名称是否已存在
if [ -d "skills/$NEW_NAME" ]; then
    echo "❌ 错误: 技能 $NEW_NAME 已存在！"
    exit 1
fi

echo "1️⃣ 重命名技能目录..."
mv "skills/$OLD_NAME" "skills/$NEW_NAME"
echo "   ✓ skills/$OLD_NAME → skills/$NEW_NAME"
echo ""

echo "2️⃣ 更新 SKILL.md 中的 name 字段..."
if [ -f "skills/$NEW_NAME/SKILL.md" ]; then
    # macOS 的 sed 需要 -i '' 参数
    sed -i '' "s/^name: $OLD_NAME$/name: $NEW_NAME/" "skills/$NEW_NAME/SKILL.md"
    echo "   ✓ 已更新 SKILL.md"
else
    echo "   ⚠️  SKILL.md 不存在，跳过"
fi
echo ""

echo "3️⃣ 更新测试用例..."
if [ -f "tests/skill-routing-tests.json" ]; then
    sed -i '' "s/\"skill\": \"$OLD_NAME\"/\"skill\": \"$NEW_NAME\"/g" "tests/skill-routing-tests.json"
    sed -i '' "s/\"expectedSkill\": \"$OLD_NAME\"/\"expectedSkill\": \"$NEW_NAME\"/g" "tests/skill-routing-tests.json"
    echo "   ✓ 已更新 skill-routing-tests.json"
else
    echo "   ⚠️  测试文件不存在，跳过"
fi
echo ""

echo "4️⃣ 搜索其他可能的引用..."
echo "   检查以下文件中是否有硬编码引用:"
echo ""

# 搜索但排除某些目录
REFS=$(grep -r "\"$OLD_NAME\"" \
    --exclude-dir=node_modules \
    --exclude-dir=.git \
    --exclude-dir=dist \
    --exclude-dir=sessions \
    --exclude="*.log" \
    --exclude="rename-skill.sh" \
    . 2>/dev/null || true)

if [ -z "$REFS" ]; then
    echo "   ✓ 未发现其他引用"
else
    echo "   ⚠️  发现以下引用，请手动检查:"
    echo "$REFS"
fi
echo ""

echo "════════════════════════════════════════════════════════════"
echo "✅ 重命名完成！"
echo ""
echo "后续步骤:"
echo "1. 重启服务: npm run restart"
echo "2. 运行测试: node tests/run-skill-routing-tests.ts"
echo "3. 验证 Discord 实际调用"
echo "════════════════════════════════════════════════════════════"
