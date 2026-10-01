#!/bin/bash
# 智慧教学云 模块巡检：逐个打开核心页面，取文本 + 截图，输出健康报告
#
# 用法:
#   bash smoke.sh [别名] [过滤词]
#     bash smoke.sh                # 巡检 test（默认）
#     bash smoke.sh lyyz           # 巡检 lyyz —— 生产站，需加 --yes 确认
#     bash smoke.sh lyyz --yes     # 确认在生产站执行【只读】巡检
#     bash smoke.sh test exam      # 只跑 slug 含 exam 的页面
#
# 本脚本**全程只读**：仅 open + read + screenshot，不点任何提交/删除按钮。
# 生产站额外要求显式 --yes，并在报告中标注站点等级。
#
# 产物: /tmp/fuulea/<别名>/pages/<slug>.txt
#       /tmp/fuulea/<别名>/shots/<slug>-<时间戳>.png
#       /tmp/fuulea/<别名>/smoke-<时间戳>.md

set -u
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

DIR="$(cd "$(dirname "$0")" && pwd)"
# 第 1 个位置参数若命中站点别名则当站点，其余参数当过滤词
ALIAS="test"
FILTER=""
CONFIRM=""
POS=0
for a in "$@"; do
  case "$a" in
    --yes) CONFIRM="yes"; continue ;;
  esac
  if [ "$POS" -eq 0 ] && grep -qE "^${a}\|" "$DIR/sites.conf" 2>/dev/null; then
    ALIAS="$a"
  else
    FILTER="$a"
  fi
  POS=1
done

LINE=$(grep -E "^${ALIAS}\|" "$DIR/sites.conf" | head -1)
BASE=$(printf '%s' "$LINE" | cut -d'|' -f2)
TIER=$(printf '%s' "$LINE" | cut -d'|' -f3)
DESC=$(printf '%s' "$LINE" | cut -d'|' -f4)

# 浏览器会话：统一走 browser.sh（命名会话 + open 后确认真的渲染出来 + 坏状态硬重置）
. "$DIR/browser.sh" 2>/dev/null || true
export AGENT_BROWSER_SESSION="$(session_name "$ALIAS")"
export FUULEA_RESET="$DIR/browser.sh"

if [ "$TIER" = "prod" ] && [ "$CONFIRM" != "yes" ]; then
  # 注意: 变量后面紧跟全角字符时要写成 ${VAR}，否则部分 shell 会把
  # 多字节字符的字节当成变量名的一部分，报 "unbound variable"。
  echo "已阻止: '${ALIAS}' 是生产站 (${DESC})。" >&2
  echo "本脚本只做只读巡检，但仍需你明确确认后再跑：" >&2
  echo "  bash smoke.sh ${ALIAS} --yes" >&2
  exit 4
fi

OUT="/tmp/fuulea/$ALIAS"
STAMP=$(date +%m%d-%H%M%S)
mkdir -p "$OUT/pages" "$OUT/shots"
REPORT="$OUT/smoke-$STAMP.md"

ROUTES="course|/course
task|/task
exam|/exam
tk|/tk
target_student|/target/for-student
target_knowledge|/target/for-knowledge
analysis_grade|/analysis/grade/overview
analysis_subject|/analysis/grade/graph
analysis_class|/analysis/class
classroom|/classroom
booklet|/booklet
vocabulary|/vocabulary
algo_skill|/algo/skill
survey|/student-survey/home
bo|/bo/dashboard
dashboard|/dashboard
search|/search"

bash "$DIR/login.sh" "$ALIAS" || { echo "登录失败，终止"; exit 1; }

{
  echo "# 智慧教学云巡检报告"
  echo ""
  echo "- 站点: $ALIAS ($BASE)"
  echo "- 等级: $TIER — $DESC"
  echo "- 时间: $STAMP"
  echo "- 说明: 全程只读，未执行任何写操作"
  echo ""
  echo "| 模块 | 路由 | 文本字节 | 状态 | 截图 |"
  echo "|---|---|---|---|---|"
} > "$REPORT"

while IFS='|' read -r slug route; do
  [ -z "$slug" ] && continue
  if [ -n "$FILTER" ] && ! printf '%s' "$slug" | grep -q "$FILTER"; then continue; fi

  # 打开并确认真的渲染出来了（不是 about:blank）；失败会自动硬重置会话重试
  open_checked "$BASE$route" || echo "  ⚠️ $slug 页面未能渲染出来"
  sleep 2

  agent-browser read > "$OUT/pages/$slug.txt" 2>/dev/null
  agent-browser screenshot "$OUT/shots/$slug-$STAMP.png" >/dev/null 2>&1

  BYTES=$(wc -c < "$OUT/pages/$slug.txt" | tr -d ' ')
  # 左侧导航每页都重复出现且长度不固定，用最后一个「退出登录」作为切分点，
  # 其后才是真正的页面正文（固定截 300 字节会误判考试/学情等页为空）。
  BODY=$(awk '/退出登录/{last=NR} {a[NR]=$0} END{for(i=last+1;i<=NR;i++) print a[i]}' "$OUT/pages/$slug.txt")
  BODYLEN=${#BODY}

  # 判定顺序：先报错，再看正文体量。
  # 不能一见到「暂无数据」就判空 —— 课程/班级等页主体有大量数据，子区域空也会出现这四个字。
  if printf '%s' "$BODY" | grep -qE '服务器开小差|加载失败|获取失败|操作失败'; then
    STATUS="❌ 报错"
  elif [ "$BODYLEN" -lt 200 ]; then
    STATUS="⚠️ 空数据"
  elif printf '%s' "$BODY" | grep -qE '暂无数据|未找到相关内容|还没有创建'; then
    STATUS="✅ 正常（局部空）"
  else
    STATUS="✅ 正常"
  fi

  echo "| $slug | \`$route\` | $BYTES | $STATUS | shots/$slug-$STAMP.png |" >> "$REPORT"
  echo "checked: $slug $route -> $STATUS ($BYTES bytes)"
done <<EOF
$ROUTES
EOF

agent-browser close >/dev/null 2>&1
echo ""
echo "报告: $REPORT"
echo "REPORT=$REPORT"
