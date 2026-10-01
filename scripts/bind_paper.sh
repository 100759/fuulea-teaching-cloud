#!/bin/bash
# 给某场考试的某个学科「关联已有试卷」（写操作！）
#
# 用法:
#   bash bind_paper.sh <站点别名> <考试ID> <学科> <试卷编号> [--yes] [期望卷名关键词]
#
# 例:
#   bash bind_paper.sh lyyz 29181 生物 81402805 --yes
#   bash bind_paper.sh lyyz 29181 生物 81402805 --yes "期中考试"
#
# 安全:
#   - 这是**写操作**，会改动考试数据。站点等级为 prod 时必须显式 --yes。
#   - 执行前后各截一张图，存到 /tmp/fuulea/<别名>/shots/。
#   - 结束后**重新加载页面复核**，并打印该学科行的最终状态。
#   - 只动指定学科的那一行，不动其他学科。
#
# 实测要点（别删）:
#   1) 弹层输入试卷编号后，必须按一次 Enter 才会出候选项；
#   2) 点「确定」会先做表单校验，校验不过会静默不提交但弹层照样关闭
#      —— 所以"弹层关了"不等于"绑定成功"，必须回列表核对；
#   3) 页面原地刷新不更新 DOM，必须重新 open 同一 URL 才能看到结果。
#   4) ⚠️ 变量后面紧跟全角字符（如 `$PAPER（`、`「$OPT」`）会被 bash 当成变量名一部分，
#      报 `unbound variable` 并中断脚本 —— 一律写成 `${VAR}`。本脚本已全部修正。

set -u
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

DIR="$(cd "$(dirname "$0")" && pwd)"
ALIAS="${1:-}"; EXAM="${2:-}"; SUBJECT="${3:-}"; PAPER="${4:-}"
CONFIRM=""; EXPECT=""
shift 4 2>/dev/null || true
for a in "$@"; do
  case "$a" in
    --yes) CONFIRM="yes" ;;
    *) EXPECT="$a" ;;
  esac
done

if [ -z "$ALIAS" ] || [ -z "$EXAM" ] || [ -z "$SUBJECT" ] || [ -z "$PAPER" ]; then
  echo "用法: bash bind_paper.sh <站点别名> <考试ID> <学科> <试卷编号> [--yes] [期望卷名关键词]" >&2
  exit 2
fi

LINE=$(grep -E "^${ALIAS}\|" "$DIR/sites.conf" 2>/dev/null | head -1)
if [ -z "${LINE:-}" ]; then echo "未知站点别名 '$ALIAS'" >&2; exit 2; fi
BASE=$(printf '%s' "$LINE" | cut -d'|' -f2)
TIER=$(printf '%s' "$LINE" | cut -d'|' -f3)

# 浏览器会话：统一走 browser.sh（会话命名 + open 后确认真的渲染出来 + 坏状态硬重置）
. "$DIR/browser.sh" 2>/dev/null || true
export AGENT_BROWSER_SESSION="$(session_name "$ALIAS")"

if [ "$TIER" = "prod" ] && [ "$CONFIRM" != "yes" ]; then
  echo "已阻止: '${ALIAS}' 是生产站，绑定试卷是写操作，需显式确认：" >&2
  echo "  bash bind_paper.sh ${ALIAS} ${EXAM} ${SUBJECT} ${PAPER} --yes" >&2
  exit 4
fi

SHOTS="/tmp/fuulea/$ALIAS/shots"
mkdir -p "$SHOTS"
URL="$BASE/exam/$EXAM/detail"
TAG="${EXAM}-${SUBJECT}-${PAPER}"

bash "$DIR/login.sh" "$ALIAS" >/dev/null 2>&1 || { echo "登录失败" >&2; exit 1; }

echo "==> 绑定: 考试 ${EXAM} 的【${SUBJECT}】<- 试卷 ${PAPER}  (${ALIAS})"

# --- 绑定前 ---
open_checked "$URL" || true; sleep 2
# ⚠️ 截图前必须把目标学科行滚进视口：考试详情页学科行很多，
#    靠后的学科（如政治/历史/地理）在折叠线以下，直接截图只会拍到页面顶部，
#    导致 before/after 两张图**逐字节相同**、留证形同虚设（2026-09-30 实测 39 条里 26 条中招）。
scroll_to_row() {
  agent-browser eval "(()=>{const lbl=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='【${SUBJECT}】'&&e.offsetParent); if(!lbl) return 'no-label'; lbl.scrollIntoView({block:'center'}); return 'ok'})()" >/dev/null 2>&1
  sleep 1
}
scroll_to_row
BEFORE=$(agent-browser eval "(()=>{const t=document.body.innerText.split('退出登录').pop();const i=t.indexOf('【${SUBJECT}】');return i<0?'NOT_FOUND':t.slice(i,i+90).replace(/\n+/g,' ')})()" 2>/dev/null | tr -d '\n')
echo "    绑定前: $BEFORE"
agent-browser screenshot "$SHOTS/$TAG-before.png" >/dev/null 2>&1

if printf '%s' "$BEFORE" | grep -q "$PAPER"; then
  echo "    ⏭ 已经是绑定 $PAPER 的状态，跳过"
  exit 0
fi
if ! printf '%s' "$BEFORE" | grep -q '关联已有试卷'; then
  echo "    ❌ 该学科行没有「关联已有试卷」入口，可能已绑其它卷或页面结构变化" >&2
  exit 1
fi

# --- 打开弹层 ---
R=$(agent-browser eval "(()=>{
  const lbl=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='【${SUBJECT}】'&&e.offsetParent);
  if(!lbl) return 'no-label';
  let row=lbl;
  for(let i=0;i<6&&row;i++){ if(row.querySelector&&row.querySelector('button')&&row.innerText.includes('关联已有试卷')) break; row=row.parentElement; }
  if(!row) return 'no-row';
  const b=[...row.querySelectorAll('button')].find(x=>x.innerText.trim()==='关联已有试卷');
  if(!b) return 'no-btn';
  b.click(); return 'clicked';
})()" 2>/dev/null | tr -d '" \n')
[ "$R" = "clicked" ] || { echo "    ❌ 打开弹层失败: $R" >&2; exit 1; }
sleep 3

# --- 填编号 + Enter 触发搜索 ---
agent-browser type ".ant-modal input.ant-select-selection-search-input" "$PAPER" >/dev/null 2>&1
sleep 1
agent-browser press Enter >/dev/null 2>&1
sleep 3

OPT=$(agent-browser eval "(()=>{const o=document.querySelector('.ant-select-item-option'); return o?o.innerText.trim():'NO_OPTION'})()" 2>/dev/null | tr -d '"')
echo "    候选项: $OPT"
if [ "$OPT" = "NO_OPTION" ]; then
  echo "    ❌ 未出现候选项（编号 ${PAPER} 可能不存在）" >&2
  agent-browser close >/dev/null 2>&1
  exit 1
fi

# 卷名护栏：候选项名称与期望关键词比对（去空白后）。
# 用「互为子串 / 互为前缀」判定，既能容忍下拉里的截断显示，
# 又不会把「…第1次月考」和「…第2次月考」误判成同一个（前缀必须覆盖到有区分度的那一段）。
name_matches() {
  python3 - "$1" "$2" <<'PY'
import sys, re
opt = re.sub(r'\s+', '', sys.argv[1] or '')
exp = re.sub(r'\s+', '', sys.argv[2] or '')
if not exp:
    sys.exit(0)                     # 没给期望值 → 不校验
if exp in opt or opt in exp:
    sys.exit(0)                     # 互为子串
if len(opt) >= 8 and exp.startswith(opt):
    sys.exit(0)                     # 候选项被截断显示
if len(exp) >= 8 and opt.startswith(exp):
    sys.exit(0)                     # 卷名比章节名多了后缀
sys.exit(1)
PY
}

if [ -n "$EXPECT" ] && ! name_matches "$OPT" "$EXPECT"; then
  echo "    ❌ 候选项「${OPT}」与期望关键词「${EXPECT}」不符，已中止（防绑错）" >&2
  agent-browser close >/dev/null 2>&1
  exit 1
fi

# --- 选中 + 确定 ---
agent-browser eval "(()=>{const o=document.querySelector('.ant-select-item-option'); if(!o)return 'nf'; o.click(); return 'ok'})()" >/dev/null 2>&1
sleep 2
agent-browser screenshot "$SHOTS/$TAG-dialog.png" >/dev/null 2>&1
agent-browser eval "(()=>{const m=document.querySelector('.ant-modal'); if(!m)return 'no-modal'; const b=[...m.querySelectorAll('button')].find(x=>x.innerText.trim()==='确定'); if(!b)return 'no-btn'; b.click(); return 'confirmed'})()" >/dev/null 2>&1
sleep 5

# --- 必须重新加载才能看到结果；且重载后 DOM 更新可能慢于固定 sleep，故轮询复核 ---
AFTER=""
for attempt in 1 2 3; do
  open_checked "$URL" || true; sleep 2
  AFTER=$(agent-browser eval "(()=>{const t=document.body.innerText.split('退出登录').pop();const i=t.indexOf('【${SUBJECT}】');return i<0?'NOT_FOUND':t.slice(i,i+90).replace(/\n+/g,' ')})()" 2>/dev/null | tr -d '\n')
  if printf '%s' "$AFTER" | grep -q "$PAPER"; then break; fi
  echo "    (第 ${attempt} 次复核未看到 ${PAPER}，重载重试)"
done
echo "    绑定后: $AFTER"
scroll_to_row
agent-browser screenshot "$SHOTS/$TAG-after.png" >/dev/null 2>&1

# --- 留一份**文本**证据（截图可能因视口取景而失真，文本是精确的）---
if printf '%s' "$AFTER" | grep -q "$PAPER"; then RESULT="成功"; else RESULT="失败"; fi
{
  echo "考试ID: ${EXAM}"
  echo "学科: ${SUBJECT}"
  echo "试卷: ${PAPER}"
  echo "期望卷名关键词: ${EXPECT}"
  echo
  echo "绑定前: ${BEFORE}"
  echo "候选项: ${OPT}"
  echo "绑定后: ${AFTER}"
  echo "结果: ${RESULT}"
} > "$SHOTS/$TAG-evidence.txt" 2>/dev/null

if [ "${RESULT}" = "成功" ]; then
  echo "    ✅ 成功"
  exit 0
else
  echo "    ❌ 失败：未看到试卷 ${PAPER}（弹层关闭 ≠ 绑定成功）" >&2
  exit 1
fi
