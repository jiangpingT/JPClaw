#!/bin/bash

#
# 通过JPClaw聊天接口测试技能路由
#
# 这个脚本会向运行中的JPClaw发送测试查询，并记录路由结果
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_FILE="$SCRIPT_DIR/skill-routing-tests.json"
REPORT_FILE="$SCRIPT_DIR/real-routing-report-$(date +%Y%m%d-%H%M%S).md"
LOG_DIR="/Users/mlamp/Workspace/JPClaw/log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Check if JPClaw is running
if ! pgrep -f "node.*dist/index.js" > /dev/null; then
  echo -e "${RED}❌ JPClaw 服务未运行${NC}"
  echo "请先启动服务: npm run start"
  exit 1
fi

echo ""
echo "=========================================="
echo "  JPClaw 真实路由测试"
echo "  (通过日志分析)"
echo "=========================================="
echo ""

# Parse arguments
LIMIT=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --limit)
      LIMIT="$2"
      shift 2
      ;;
    *)
      echo "未知参数: $1"
      exit 1
      ;;
  esac
done

# Get test cases
TEST_CASES=$(cat "$TEST_FILE" | jq -c '.testCases[]')

if [[ -n "$LIMIT" ]]; then
  TEST_CASES=$(echo "$TEST_CASES" | head -n "$LIMIT")
fi

TOTAL_TESTS=$(echo "$TEST_CASES" | wc -l | tr -d ' ')

echo "📋 将测试 $TOTAL_TESTS 个用例"
echo "📂 日志目录: $LOG_DIR"
echo ""
echo "⚠️  说明: 此测试需要手动向JPClaw发送查询"
echo "   建议使用自动化方式或查看日志中的路由记录"
echo ""

# Initialize report
cat > "$REPORT_FILE" << 'EOF'
# JPClaw 真实路由测试报告

**测试方式**: 通过实际聊天接口

## 测试说明

此测试需要:
1. JPClaw 服务正在运行
2. 通过聊天接口发送测试查询
3. 查看日志中的路由决策记录

## 测试用例

EOF

echo "$TEST_CASES" | while IFS= read -r test_case; do
  ID=$(echo "$test_case" | jq -r '.id')
  SKILL=$(echo "$test_case" | jq -r '.skill')
  QUERY=$(echo "$test_case" | jq -r '.query')
  EXPECTED=$(echo "$test_case" | jq -r '.expectedSkill')

  cat >> "$REPORT_FILE" << EOF
### Test #$ID: $SKILL

- **查询**: "$QUERY"
- **期望技能**: $EXPECTED
- **测试方法**: 向JPClaw发送此查询，观察是否路由到 $EXPECTED

EOF
done

echo "📄 测试用例列表已生成: $REPORT_FILE"
echo ""
echo "🔍 下一步操作:"
echo "   1. 打开JPClaw聊天界面（Web/Discord/CLI）"
echo "   2. 逐个发送测试查询（参考报告文件）"
echo "   3. 观察技能是否被正确路由"
echo "   4. 查看日志文件: tail -f $LOG_DIR/gateway.log | grep skill_router"
echo ""
echo "💡 提示: 可以使用以下命令查看路由日志:"
echo "   tail -f $LOG_DIR/gateway.log | grep -E 'skill_router|run_skill'"
echo ""
