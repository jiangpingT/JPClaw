#!/bin/bash
# JPClaw 80个技能路由测试 - 简化版
# 作者: 阿策 for 姜哥

set -e
cd "$(dirname "$0")/.."

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 检查Gateway
check_gateway() {
  if http_proxy= https_proxy= curl -s --max-time 3 http://127.0.0.1:18790/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} Gateway运行中"
    return 0
  else
    echo -e "${RED}✗${NC} Gateway未运行 (端口18790)"
    echo -e "  启动命令: ${YELLOW}npm run dev -- gateway${NC}"
    return 1
  fi
}

# 帮助
show_help() {
  echo "用法: $0 [模式]"
  echo ""
  echo "模式:"
  echo "  quick      快速测试(前10个高优先级) [默认]"
  echo "  full       完整测试(全部80个)"
  echo "  high       高优先级测试"
  echo "  help       显示帮助"
  echo ""
  echo "示例:"
  echo "  $0           # 快速测试"
  echo "  $0 full      # 完整测试"
  echo "  $0 high      # 高优先级"
}

# 主逻辑
MODE="${1:-quick}"

case $MODE in
  quick)
    echo -e "\n${YELLOW}快速测试:${NC} 前10个高优先级技能\n"
    check_gateway || exit 1
    tsx tests/run-skill-routing-tests.ts --limit 10 --priority high
    ;;

  full)
    echo -e "\n${YELLOW}完整测试:${NC} 全部80个技能\n"
    check_gateway || exit 1
    tsx tests/run-skill-routing-tests.ts
    ;;

  high)
    echo -e "\n${YELLOW}高优先级测试${NC}\n"
    check_gateway || exit 1
    tsx tests/run-skill-routing-tests.ts --priority high
    ;;

  help|--help|-h)
    show_help
    ;;

  *)
    echo -e "${RED}未知模式:${NC} $MODE"
    show_help
    exit 1
    ;;
esac
