#!/bin/bash

# map-poi 技能快速测试脚本

echo "🗺️  map-poi 技能测试工具"
echo "======================================"
echo ""

# 检查API Key
if [ -z "$AMAP_API_KEY" ]; then
    echo "⚠️  未检测到 AMAP_API_KEY 环境变量"
    echo ""
    echo "请按以下步骤操作："
    echo "1. 访问 https://console.amap.com/dev/key/app"
    echo "2. 注册/登录高德开放平台"
    echo "3. 创建应用并获取Key"
    echo "4. 运行：export AMAP_API_KEY=\"你的Key\""
    echo ""
    read -p "已有Key？请输入（回车跳过）: " user_key
    
    if [ -n "$user_key" ]; then
        export AMAP_API_KEY="$user_key"
        echo "✅ API Key已临时设置"
        echo ""
    else
        echo "❌ 无法继续测试，请先配置API Key"
        exit 1
    fi
fi

echo "✅ API Key已配置"
echo ""

# 选择测试模式
echo "请选择测试模式："
echo "1) 运行完整测试套件（推荐）"
echo "2) 自定义查询"
echo "3) 快速演示（查找明略科技附近理发店）"
echo ""
read -p "请选择 [1-3]: " choice

case $choice in
    1)
        echo ""
        echo "🧪 运行完整测试套件..."
        echo ""
        node skills/map-poi/test.js
        ;;
    2)
        echo ""
        read -p "请输入地址: " address
        read -p "请输入搜索关键词（如：理发店、餐厅）: " keyword
        read -p "搜索半径（米，默认1000）: " radius
        radius=${radius:-1000}
        
        echo ""
        echo "🔍 正在查询..."
        echo ""
        
        node -e "
        import('./index.js').then(module => {
          module.run({
            address: '$address',
            keyword: '$keyword',
            radius: $radius
          }).then(result => {
            if (result.success) {
              console.log(result.summary);
            } else {
              console.log('❌ 错误:', result.message);
            }
          });
        });
        "
        ;;
    3)
        echo ""
        echo "🚀 快速演示：查找明略科技附近理发店"
        echo ""
        
        node -e "
        import('./index.js').then(module => {
          module.run({
            address: '北京市朝阳区望京北路1号中国数码港大厦',
            keyword: '理发店',
            radius: 1000,
            limit: 5
          }).then(result => {
            if (result.success) {
              console.log(result.summary);
              console.log('');
              console.log('📊 详细数据：');
              console.log(JSON.stringify(result, null, 2));
            } else {
              console.log('❌ 错误:', result.message);
            }
          });
        });
        "
        ;;
    *)
        echo "❌ 无效选择"
        exit 1
        ;;
esac

echo ""
echo "======================================"
echo "✨ 测试完成！"
echo ""
echo "💡 提示："
echo "  - 永久配置Key：echo 'export AMAP_API_KEY=\"你的Key\"' >> ~/.zshrc"
echo "  - 查看文档：cat skills/map-poi/README.md"
echo "  - 在对话中使用：直接问我'附近有什么理发店'"
echo ""
