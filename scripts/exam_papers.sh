#!/bin/bash
# 考试「关联已有试卷」——跨学科批量绑卷流水线（只读为主，仅 bind 会写）
#
# 用法:
#   bash exam_papers.sh <站点别名> <子命令> [--yes] [--allow-partial] [--from <提案文件>]
#
# 子命令（前四个纯只读）:
#   snapshot       抓全站「考试 × 学科」绑卷矩阵              -> matrix.jsonl
#   scan-courses   抓各学科课程的 章节 -> 试卷编号            -> ch_<学科>.jsonl (+ meta + scan_summary.json)
#   plan           配对 + 生成绑定提案与缺口报告              -> proposals.json / plan_report.md
#   verify         逐条核对每个卷号的候选项卷名（只读）        -> verify.jsonl
#   bind           按 proposals.json 逐条绑定（**写操作**，prod 需 --yes）
#   audit          重扫并与 snapshot 基线 diff（只读，查副作用）
#   status         显示当前工作目录的产物概况
#   reset          关掉本站点的浏览器会话（页面卡死/get url=about:blank 时用）
#
# 典型流程:
#   bash exam_papers.sh lyyz snapshot          # ① 基线
#   bash exam_papers.sh lyyz scan-courses      # ② 摸清各科可用的卷
#   bash exam_papers.sh lyyz plan              # ③ 出提案给用户看
#   bash exam_papers.sh lyyz verify            # ④ 只读核对卷名
#   bash exam_papers.sh lyyz bind --yes        # ⑤ 用户批准后执行
#   bash exam_papers.sh lyyz audit             # ⑥ 逐格 diff 查副作用
#
# 工作目录: /tmp/fuulea/<别名>/papers/
#
# --allow-partial: scan-courses 有学科失败时，plan/bind 默认**拒绝**执行
#                  （防"只基于半份数据"出提案）。确要用残缺数据时必须显式加此参数。
#
# --from <文件>: verify / bind / audit 改读指定的提案 JSON（数组，元素含 examId/subject/paper/chapter），
#                而不是工作目录里的 proposals.json。用于「plan 自动配对失败、需人工推断」的
#                歧义章节（见 references/bind-papers-workflow.md 的「歧义章节人工推断」）。
#                例: bash exam_papers.sh lyyz verify --from proposals_math_manual.json
#                ⚠️ 一条流水线里有多批提案时，audit 的期望清单要**手动合并**成一份再传 --from，
#                   否则 audit 会拿单批去对"实际新增了多批"的全量 diff，报出假的"不一致"。
set -u
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

DIR="$(cd "$(dirname "$0")" && pwd)"
ALIAS="${1:-}"; CMD="${2:-}"; shift 2 2>/dev/null || true
CONFIRM=""; PARTIAL=""; SUBJ_ONLY=""; SRC=""
# 注意：`--from` 带一个值，不能用单参 for 循环解析（会把文件名当成学科名）。
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) CONFIRM="yes"; shift ;;
    --allow-partial) PARTIAL="yes"; shift ;;
    --from) [ $# -ge 2 ] || { echo "--from 缺少文件名" >&2; exit 2; }; SRC="$2"; shift 2 ;;
    --from=*) SRC="${1#--from=}"; shift ;;
    *) SUBJ_ONLY="$SUBJ_ONLY $1"; shift ;;
  esac
done
SUBJ_ONLY="${SUBJ_ONLY//,/ }"
SUBJ_ONLY="$(printf '%s' "$SUBJ_ONLY" | tr -s ' ' | sed 's/^ //; s/ $//')"

if [ -z "$ALIAS" ] || [ -z "$CMD" ]; then
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi

LINE=$(grep -E "^${ALIAS}\|" "$DIR/sites.conf" 2>/dev/null | head -1)
if [ -z "${LINE:-}" ]; then echo "未知站点别名 '${ALIAS}'（见 scripts/sites.conf）" >&2; exit 2; fi
BASE=$(printf '%s' "$LINE" | cut -d'|' -f2)
TIER=$(printf '%s' "$LINE" | cut -d'|' -f3)
export FUULEA_BASE="$BASE"

# 命名会话（与 login.sh / bind_paper.sh 一致）。默认会话 `default` 是全机共享的，
# 且会话状态文件坏掉时 open 会"假成功"、页面停在 about:blank —— 见 browser.sh 头部说明。
. "$DIR/browser.sh" 2>/dev/null || true
export AGENT_BROWSER_SESSION="$(session_name "$ALIAS")"
# 供 node 脚本在页面打不开时回调硬重置（scan_course.js / scan_matrix.js / verify_bindings.js）
export FUULEA_RESET="$DIR/browser.sh"

WORK="/tmp/fuulea/$ALIAS/papers"
mkdir -p "$WORK"
P="$DIR/papers"
SUBJECTS="语文 数学 英语 物理 化学 生物 历史 地理 政治"

echo "站点: $ALIAS ($BASE) 等级: $TIER   工作目录: $WORK"

login() { bash "$DIR/login.sh" "$ALIAS" >/dev/null 2>&1 || { echo "登录失败" >&2; exit 1; }; }

# 提案文件解析：默认用工作目录的 proposals.json，给了 --from 就用那个文件
# （相对路径按工作目录解析；绝对路径原样用）。
resolve_src() {
  local f="${SRC:-$WORK/proposals.json}"
  case "$f" in /*) printf '%s' "$f" ;; *) printf '%s' "$WORK/$f" ;; esac
}

# 扫描完整性闸门：scan_summary.json 说"不完整"就拦下来
require_complete_scan() {
  [ -f "$WORK/scan_summary.json" ] || { echo "缺少 scan_summary.json，先跑 scan-courses" >&2; exit 2; }
  python3 - "$WORK" <<'PY' || exit 5
import json, sys, os
d = json.load(open(os.path.join(sys.argv[1], 'scan_summary.json'), encoding='utf-8'))
if d.get('complete'):
    sys.exit(0)
bad = d.get('failed') or [s['subject'] for s in d.get('subjects', []) if not s.get('ok')]
print('已阻止: 上次 scan-courses 不完整，缺/不可靠的学科: ' + '、'.join(bad), file=sys.stderr)
print('  这样生成的提案只基于半份数据，会少报可绑定项。', file=sys.stderr)
print('  正确做法: bash exam_papers.sh <别名> reset && bash exam_papers.sh <别名> scan-courses', file=sys.stderr)
print('  确实要用残缺数据: 追加 --allow-partial', file=sys.stderr)
sys.exit(1)
PY
}

case "$CMD" in
  snapshot)
    login
    node "$P/scan_matrix.js" "$WORK/matrix.jsonl"
    ;;

  scan-courses)
    login
    # 可选：只重扫指定学科（逗号或空格分隔），如 `scan-courses 化学`。
    # 给了学科就**不**清其他科的产物，扫完直接合并进完整性清单，不用整批重来（省十几分钟）。
    if [ -n "$SUBJ_ONLY" ]; then
      echo "只扫描: $SUBJ_ONLY"
    else
      # ⚠️ 整批扫描必须先清掉上一次的产物。否则某科扫失败时会留下**过期的**
      #    ch_<学科>.jsonl，被 plan 当成有效数据用 —— 表现为"提案看着挺合理，
      #    其实只基于半份数据"。
      rm -f "$WORK"/ch_*.jsonl "$WORK"/ch_*.meta.json "$WORK/scan_summary.json" \
            "$WORK/.scan_ok" "$WORK/.scan_fail" "$WORK"/.scan_*.log
    fi
    FOUND=0
    ok_node() { node "$P/scan_course.js" "$cid" "$WORK/ch_${sub}.jsonl" > "$LOG" 2>&1; }
    while IFS='|' read -r site sub sid cid cname; do
      case "$site" in ''|'#'*) continue;; esac
      [ "$site" = "$ALIAS" ] || continue
      if [ -n "$SUBJ_ONLY" ]; then
        case " $SUBJ_ONLY " in *" $sub "*) ;; *) continue;; esac
      fi
      FOUND=1
      echo "==> [$sub] $cname (courseId=$cid)"
      LOG="$WORK/.scan_${sub}.log"
      if ok_node; then
        tail -n 20 "$LOG"
        echo "$sub" >> "$WORK/.scan_ok"
      else
        # 失败就地重试一次：先硬重置会话（页面打不开多半是这个原因），再扫
        tail -n 12 "$LOG"
        echo "    ⚠️ [$sub] 首次失败，硬重置会话后重试一次"
        hard_reset mine
        if ok_node; then
          tail -n 20 "$LOG"
          echo "$sub" >> "$WORK/.scan_ok"
        else
          tail -n 30 "$LOG"
          echo "    ⚠️ [$sub] 扫描失败（已重试）"
          echo "$sub" >> "$WORK/.scan_fail"
        fi
      fi
    done < "$P/subject-courses.conf"
    [ "$FOUND" = "1" ] || { echo "在 subject-courses.conf 里没找到站点 '$ALIAS' / 指定学科的登记" >&2; exit 2; }

    # 本次跑成功的学科，从历史失败清单里摘掉（支持只重扫个别学科后直接合流）
    if [ -n "$SUBJ_ONLY" ] && [ -f "$WORK/.scan_ok" ] && [ -f "$WORK/.scan_fail" ]; then
      grep -vxFf "$WORK/.scan_ok" "$WORK/.scan_fail" > "$WORK/.scan_fail.tmp" 2>/dev/null || true
      mv -f "$WORK/.scan_fail.tmp" "$WORK/.scan_fail"
    fi

    # 汇总完整性清单，供 plan/bind 做闸门
    python3 - "$WORK" "$SUBJECTS" <<'PY'
import json, sys, os
w, subs = sys.argv[1], sys.argv[2].split()
def rd(p):
    return [l.strip() for l in open(p, encoding='utf-8') if l.strip()] if os.path.exists(p) else []
scanned, failed = rd(os.path.join(w, '.scan_ok')), rd(os.path.join(w, '.scan_fail'))
out = []
for s in subs:
    f, m = os.path.join(w, 'ch_%s.jsonl' % s), os.path.join(w, 'ch_%s.meta.json' % s)
    ent = {'subject': s, 'jsonl': os.path.exists(f), 'chapters': 0, 'ok': False,
           'unreliable': [], 'error': None}
    if os.path.exists(m):
        try:
            mm = json.load(open(m, encoding='utf-8'))
            ent.update(chapters=mm.get('chapters', 0), ok=bool(mm.get('ok')),
                       unreliable=mm.get('unreliable', []))
        except Exception as e:
            ent['error'] = str(e)
    elif s in failed:
        ent['error'] = '扫描失败（见 .scan_%s.log）' % s
    else:
        ent['error'] = '缺 meta.json'
    out.append(ent)
complete = (not failed) and all(x['jsonl'] and x['ok'] for x in out)
json.dump({'scanned': scanned, 'failed': failed, 'subjects': out, 'complete': complete},
          open(os.path.join(w, 'scan_summary.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
print('')
print('== 扫描完整性: %s' % ('OK（9 科齐全且可靠）' if complete else '⚠️ 不完整'))
for x in out:
    flag = 'OK ' if (x['jsonl'] and x['ok']) else 'BAD'
    print('   %s %-3s 章节=%-3s %s' % (flag, x['subject'], x['chapters'], x['error'] or ''))
if not complete:
    print('   → 修正办法: reset 后重跑 scan-courses；确要用残缺数据加 --allow-partial')
PY
    rm -f "$WORK/.scan_ok" "$WORK/.scan_fail"
    ;;

  plan)
    ARG=""
    [ "$PARTIAL" = "yes" ] && ARG="--allow-partial"
    [ "$PARTIAL" = "yes" ] || require_complete_scan
    python3 "$P/plan_bindings.py" "$WORK" $ARG
    ;;

  verify)
    login
    SRC_F="$(resolve_src)"
    [ -f "$SRC_F" ] || { echo "缺少提案文件 ${SRC_F}（先跑 plan，或用 --from <文件> 指定）" >&2; exit 2; }
    OUT_F="$WORK/verify.jsonl"
    [ -n "$SRC" ] && OUT_F="$WORK/verify_$(basename "${SRC%.json}").jsonl"
    node "$P/verify_bindings.js" "$SRC_F" "$OUT_F"
    ;;

  bind)
    if [ "$TIER" = "prod" ] && [ "$CONFIRM" != "yes" ]; then
      echo "已阻止: '${ALIAS}' 是生产站，bind 是写操作，需显式确认：" >&2
      echo "  bash exam_papers.sh ${ALIAS} bind --yes" >&2
      exit 4
    fi
    [ -f "$WORK/proposals.json" ] || { echo "缺少 proposals.json，先跑 plan" >&2; exit 2; }
    [ "$PARTIAL" = "yes" ] || require_complete_scan
    login
    SRC_F="$(resolve_src)"
    [ -f "$SRC_F" ] || { echo "缺少提案文件 $SRC_F" >&2; exit 2; }
    python3 - "$SRC_F" <<'PY' > "$WORK/bind_items.tsv"
import json,sys,os
for p in json.load(open(sys.argv[1],encoding='utf-8')):
    # 期望关键词 = 课程里的章节名（试卷通常就按这个命名），用于候选项卷名护栏
    print("%s\t%s\t%s\t%s" % (p['examId'], p['subject'], p['paper'], p['chapter']))
PY
    OK=0; FAIL=0
    while IFS=$'\t' read -r eid sub paper chapter; do
      [ -z "$eid" ] && continue
      echo "----- 考试 ${eid}【${sub}】 <- ${paper}"
      if bash "$DIR/bind_paper.sh" "$ALIAS" "$eid" "$sub" "$paper" --yes "$chapter" 2>&1 | sed 's/^/    /'; then
        OK=$((OK+1))
      else
        FAIL=$((FAIL+1)); echo "    ⚠️ 本条未成功，请单独复查"
      fi
    done < "$WORK/bind_items.tsv"
    echo "== bind 结束: 成功 $OK / 未成功 $FAIL"
    [ "$FAIL" = "0" ]
    ;;

  audit)
    login
    [ -f "$WORK/matrix.jsonl" ] || { echo "缺少基线 matrix.jsonl" >&2; exit 2; }
    node "$P/scan_matrix.js" "$WORK/matrix_after.jsonl"
    echo
    SRC_A="$(resolve_src)"
    [ -f "$SRC_A" ] || { echo "缺少提案文件 ${SRC_A}" >&2; exit 2; }
    python3 "$P/diff_bindings.py" "$WORK/matrix.jsonl" "$WORK/matrix_after.jsonl" "$SRC_A"
    ;;

  status)
    echo "--- $WORK ---"
    ls -la "$WORK" 2>/dev/null | tail -n +2 | grep -v '^\.'
    [ -f "$WORK/scan_summary.json" ] && python3 - "$WORK" <<'PY'
import json,sys,os
d=json.load(open(os.path.join(sys.argv[1],'scan_summary.json'),encoding='utf-8'))
print('扫描完整性: %s' % ('OK' if d.get('complete') else '⚠️ 不完整 → ' + '、'.join(d.get('failed') or [])))
for x in d.get('subjects', []):
    if not (x['jsonl'] and x['ok']):
        print('   BAD %-3s %s' % (x['subject'], x['error'] or ''))
PY
    [ -f "$WORK/proposals.json" ] && \
      echo "可新增绑定: $(python3 -c "import json;print(len(json.load(open('$WORK/proposals.json'))))" 2>/dev/null) 条"
    ;;

  reset)
    echo "==> 彻底重置 '$ALIAS' 的浏览器会话 (AGENT_BROWSER_SESSION=$AGENT_BROWSER_SESSION)"
    echo "    （open 假成功 / get url 卡在 about:blank / 登录反复超时时用这个）"
    hard_reset mine
    echo "已重置。下次 login 会重新拉起浏览器。"
    echo "（要连别的会话一起清: bash $DIR/browser.sh hard-reset --all）"
    ;;

  *)
    echo "未知子命令 '$CMD'（见脚本头部用法）" >&2; exit 2;;
esac
