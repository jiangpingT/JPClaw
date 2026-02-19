#!/bin/bash
# 批量归档脚本
# 自动识别根目录下的报告文档并归档到合适的位置

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 项目根目录
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARCHIVE_SCRIPT="$PROJECT_ROOT/scripts/docs/archive-report.sh"

echo -e "${BLUE}📦 批量归档报告文档${NC}"
echo ""

# 归档计数
TOTAL=0
SUCCESS=0
SKIPPED=0

# 归档函数
archive_if_match() {
    local file="$1"
    local type="$2"
    local patterns=("${@:3}")

    for pattern in "${patterns[@]}"; do
        if [[ "$file" =~ $pattern ]]; then
            echo -e "${YELLOW}→ 归档: $file (类型: $type)${NC}"
            if bash "$ARCHIVE_SCRIPT" "$file" "$type"; then
                ((SUCCESS++))
            fi
            ((TOTAL++))
            return 0
        fi
    done
    return 1
}

# 扫描根目录的 .md 文件
cd "$PROJECT_ROOT"

echo -e "${BLUE}🔍 扫描根目录...${NC}"
echo ""

# 代码审查报告
echo -e "${BLUE}📋 代码审查报告:${NC}"
archive_if_match "CODE_REVIEW_PHASE1-5.md" "review" "CODE_REVIEW_PHASE" || true
archive_if_match "SECOND_CODE_REVIEW_REPORT.md" "review" "SECOND.*REVIEW" || true
archive_if_match "FINAL_REVIEW.md" "review" "FINAL_REVIEW" || true
archive_if_match "FINAL_REVIEW_ROUND3.md" "review" "REVIEW.*ROUND3" || true
archive_if_match "FOURTH_REVIEW_REPORT.md" "review" "FOURTH.*REVIEW" || true
archive_if_match "FIFTH_REVIEW_REPORT.md" "review" "FIFTH.*REVIEW" || true
archive_if_match "SIXTH_REVIEW_REPORT.md" "review" "SIXTH.*REVIEW" || true
archive_if_match "FINAL_REVIEW_SUMMARY.md" "review" "REVIEW.*SUMMARY" || true
echo ""

# 阶段报告
echo -e "${BLUE}🎯 阶段报告:${NC}"
archive_if_match "PHASE1_COMPLETION_REPORT.md" "phase" "PHASE1" || true
archive_if_match "PHASE2_COMPLETION_REPORT.md" "phase" "PHASE2" || true
archive_if_match "PHASE3_COMPLETION_REPORT.md" "phase" "PHASE3" || true
archive_if_match "PHASE4_COMPLETION_REPORT.md" "phase" "PHASE4" || true
archive_if_match "PHASE5_COMPLETION_REPORT.md" "phase" "PHASE5" || true
archive_if_match "FINAL_SUMMARY.md" "phase" "FINAL_SUMMARY" || true
echo ""

# 修复报告
echo -e "${BLUE}🔧 修复报告:${NC}"
archive_if_match "P0_FIXES_COMPLETE.md" "fixes" "P0.*FIXES" || true
archive_if_match "P1_FIXES_PROGRESS.md" "fixes" "P1.*PROGRESS" || true
archive_if_match "P1_SUMMARY.md" "fixes" "P1.*SUMMARY" || true
archive_if_match "CRITICAL_FIXES_APPLIED.md" "fixes" "CRITICAL.*APPLIED" || true
archive_if_match "CRITICAL_FIXES_SUMMARY.md" "fixes" "CRITICAL.*SUMMARY" || true
archive_if_match "SECURITY_FIXES.md" "fixes" "SECURITY.*FIXES" || true
echo ""

# 优化报告
echo -e "${BLUE}⚡ 优化报告:${NC}"
archive_if_match "OPTIMIZATION_COMPLETION_REPORT.md" "optimization" "OPTIMIZATION.*COMPLETION" || true
archive_if_match "LOW_PRIORITY_OPTIMIZATION_REPORT.md" "optimization" "LOW.*PRIORITY.*OPTIMIZATION" || true
echo ""

# 总结
echo ""
echo -e "${GREEN}✅ 归档完成!${NC}"
echo ""
echo -e "${BLUE}📊 统计:${NC}"
echo -e "  处理文件: ${YELLOW}$TOTAL${NC}"
echo -e "  成功归档: ${GREEN}$SUCCESS${NC}"
echo -e "  跳过: ${BLUE}$SKIPPED${NC}"
echo ""
echo -e "${YELLOW}💡 下一步:${NC}"
echo "  1. 检查 docs/reports/ 目录"
echo "  2. 更新索引: 手动编辑 docs/reports/README.md"
echo "  3. 提交更改:"
echo "     git add docs/reports/"
echo "     git commit -m 'docs: batch archive reports'"
echo ""
