#!/bin/bash
# 报告归档脚本
# 用法: ./scripts/docs/archive-report.sh <文件名> <类型>
# 示例: ./scripts/docs/archive-report.sh TONIGHT_SUMMARY.md daily

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 项目根目录
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPORTS_DIR="$PROJECT_ROOT/docs/reports"

# 帮助信息
show_help() {
    echo "报告归档脚本"
    echo ""
    echo "用法:"
    echo "  ./scripts/docs/archive-report.sh <文件名> <类型>"
    echo ""
    echo "类型选项:"
    echo "  review        - 代码审查报告 → docs/reports/reviews/"
    echo "  daily         - 每日工作总结 → docs/reports/daily/"
    echo "  phase         - 阶段性报告   → docs/reports/phases/"
    echo "  fixes         - 修复总结     → docs/reports/fixes/"
    echo "  optimization  - 优化报告     → docs/reports/optimizations/"
    echo ""
    echo "示例:"
    echo "  ./scripts/docs/archive-report.sh TONIGHT_SUMMARY.md daily"
    echo "  ./scripts/docs/archive-report.sh FIFTH_REVIEW_REPORT.md review"
    echo ""
}

# 检查参数
if [ $# -lt 2 ]; then
    show_help
    exit 1
fi

SOURCE_FILE="$1"
DOC_TYPE="$2"

# 检查源文件是否存在
if [ ! -f "$PROJECT_ROOT/$SOURCE_FILE" ]; then
    echo -e "${RED}❌ 错误: 文件不存在: $SOURCE_FILE${NC}"
    exit 1
fi

# 确定目标目录
case "$DOC_TYPE" in
    review)
        TARGET_DIR="$REPORTS_DIR/reviews"
        TYPE_PREFIX="review"
        ;;
    daily)
        TARGET_DIR="$REPORTS_DIR/daily"
        TYPE_PREFIX="daily"
        ;;
    phase)
        TARGET_DIR="$REPORTS_DIR/phases"
        TYPE_PREFIX="phase"
        ;;
    fixes)
        TARGET_DIR="$REPORTS_DIR/fixes"
        TYPE_PREFIX="fixes"
        ;;
    optimization)
        TARGET_DIR="$REPORTS_DIR/optimizations"
        TYPE_PREFIX="optimization"
        ;;
    *)
        echo -e "${RED}❌ 错误: 未知的文档类型: $DOC_TYPE${NC}"
        show_help
        exit 1
        ;;
esac

# 创建目标目录（如果不存在）
mkdir -p "$TARGET_DIR"

# 生成新文件名
CURRENT_DATE=$(date +%Y-%m-%d)
ORIGINAL_NAME=$(basename "$SOURCE_FILE" .md)

# 从原文件名提取描述
# 例如: TONIGHT_SUMMARY → tonight-summary
#       FIFTH_REVIEW_REPORT → round-5
DESCRIPTION=$(echo "$ORIGINAL_NAME" | tr '[:upper:]' '[:lower:]' | tr '_' '-')

# 特殊处理
case "$DESCRIPTION" in
    *"fifth"*|*"5"*)
        DESCRIPTION="round-5"
        ;;
    *"sixth"*|*"6"*)
        DESCRIPTION="round-6"
        ;;
    *"fourth"*|*"4"*)
        DESCRIPTION="round-4"
        ;;
    *"tonight"*"summary"*)
        DESCRIPTION="tonight-summary"
        ;;
    *"tonight"*"final"*)
        DESCRIPTION="tonight-final"
        ;;
    *"p0"*"complete"*)
        DESCRIPTION="p0-complete"
        ;;
    *"p1"*"progress"*)
        DESCRIPTION="p1-progress"
        ;;
    *"p1"*"summary"*)
        DESCRIPTION="p1-summary"
        ;;
esac

NEW_FILENAME="${CURRENT_DATE}-${TYPE_PREFIX}-${DESCRIPTION}.md"
TARGET_FILE="$TARGET_DIR/$NEW_FILENAME"

# 检查目标文件是否已存在
if [ -f "$TARGET_FILE" ]; then
    echo -e "${YELLOW}⚠️  警告: 目标文件已存在: $NEW_FILENAME${NC}"
    read -p "是否覆盖? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${BLUE}ℹ️  取消归档${NC}"
        exit 0
    fi
fi

# 移动文件
echo -e "${BLUE}📦 归档文件...${NC}"
echo -e "  源文件: ${YELLOW}$SOURCE_FILE${NC}"
echo -e "  目标: ${GREEN}docs/reports/$DOC_TYPE/$NEW_FILENAME${NC}"

mv "$PROJECT_ROOT/$SOURCE_FILE" "$TARGET_FILE"

# 更新索引文件
INDEX_FILE="$REPORTS_DIR/README.md"

echo -e "${BLUE}📝 更新索引...${NC}"

# 提取文件元数据（标题、日期等）
TITLE=$(grep -m 1 "^# " "$TARGET_FILE" | sed 's/^# //')
if [ -z "$TITLE" ]; then
    TITLE="$DESCRIPTION"
fi

echo -e "${GREEN}✅ 归档完成!${NC}"
echo ""
echo -e "${BLUE}📊 归档信息:${NC}"
echo -e "  文件名: ${GREEN}$NEW_FILENAME${NC}"
echo -e "  标题: ${GREEN}$TITLE${NC}"
echo -e "  类型: ${GREEN}$DOC_TYPE${NC}"
echo -e "  位置: ${GREEN}$TARGET_FILE${NC}"
echo ""
echo -e "${YELLOW}💡 下一步:${NC}"
echo "  1. 更新 $INDEX_FILE 的索引表格"
echo "  2. 检查文档中的链接是否需要更新"
echo "  3. 提交更改: git add docs/reports/ && git commit -m 'docs: archive $NEW_FILENAME'"
echo ""
