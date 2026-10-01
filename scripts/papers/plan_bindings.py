#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把「各学科课程的章节」与「考试」配对，生成绑定提案 + 缺口报告（纯只读，不碰浏览器）

用法: python3 plan_bindings.py <workdir> [--allow-partial]

<workdir> 里应有：
  matrix.jsonl       —— scan_matrix.js 的产出（考试清单 + 各科绑卷现状）
  scan_summary.json  —— exam_papers.sh scan-courses 的产出（各科扫描是否完整）
  ch_<学科>.jsonl    —— scan_course.js 的产出（每学科课程的 章节 -> 试卷编号）

⚠️ 默认**要求 scan-courses 完整**（9 科齐全且无不可靠章节）。
   否则拒绝出提案 —— 因为"半份数据"照样能算出一份**看起来很正常**的提案，
   只是把所有没扫到的学科都误判成"该科汇总课程无此场章节"，静默少报。
   确要用残缺数据时才加 --allow-partial（报告里会标红提示）。

产出：
  proposals.json    —— 可新增绑定的清单，供 verify_bindings.js / exam_papers.sh bind 消费
  plan_report.md    —— 覆盖总览 + 仍缺清单（含原因）

--- 配对原理（重要）---
各学科课程的章节命名风格**不统一**，例如：
  生物/语文  2024-2025第一学期高一第1次月考          （直接就是考试名）
  化学/地理  24-25上·高一月考1_龙岩一中2027届…       （学年简写 + 上/下 + 年级 + 考试类型）
  数学       龙岩一中2024—2025学年第一次月考高一数学试题   （真实卷名）
  物理       24-25学年第二学期高一第1次月考试卷
因此统一归一化成四元组 (学年, 学期, 年级, 考试类型) 再配对。

⚠️ 归一化只做**能确定的**推断。凡是推不出四元组的章节，一律**不猜**，
   列入报告让用户人工判断（缺数据绝不瞎编）。
"""
import json, re, os, sys, glob

WORK = sys.argv[1] if len(sys.argv) > 1 else '.'
ALLOW_PARTIAL = '--allow-partial' in sys.argv
SUBJECTS = ["语文", "数学", "英语", "物理", "化学", "生物", "历史", "地理", "政治"]

# ---------- 名称归一化 ----------

def year_of(s):
    """学年：2024-2025 / 2024—2025 / 2024~2025 / 24-25 / 024-2025 → '2024-2025'"""
    m = re.search(r'(20\d{2})\s*[-~—–一]\s*(20\d{2})', s)
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    m = re.search(r'(\d{2,4})\s*[-~—–]\s*(\d{2,4})', s)
    if m:
        return f"20{m.group(1)[-2:]}-20{m.group(2)[-2:]}"
    return None


def term_of(s):
    """学期。注意「24-25上·」是 上 在间隔号**前面**，别写反。"""
    if re.search(r'第一学期|上学期|学年上|上·|上_', s):
        return "第一学期"
    if re.search(r'第二学期|下学期|学年下|下·|下_', s):
        return "第二学期"
    return None


def grade_of(s):
    for g in ("高一", "高二", "高三"):
        if g in s:
            return g
    return None


def kind_of(s):
    if '开学联考' in s:
        return "开学联考"
    if '期末' in s:
        return "期末"
    if '期中' in s or '半期考' in s:
        return "期中"
    if re.search(r'月考\s*1|第1次月考|第一次月考|月考一', s):
        return "月考1"
    if re.search(r'月考\s*2|第2次月考|第二次月考|月考二', s):
        return "月考2"
    return None


def key_of(s):
    """→ ('2024-2025','第一学期','高一','月考1') 或 None（推不出就不猜）"""
    y, t, g, k = year_of(s), term_of(s), grade_of(s), kind_of(s)
    if all([y, t, g, k]):
        return (y, t, g, k)
    return None


# ---------- 读输入 ----------

def load_jsonl(p):
    out = []
    for line in open(p, encoding='utf-8'):
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


matrix = load_jsonl(os.path.join(WORK, 'matrix.jsonl'))
if not matrix:
    sys.exit('缺少 matrix.jsonl（先跑 scan-matrix）')

# ---------- 完整性闸门：拒绝用"半份数据"出提案 ----------
scan = None
_summary_p = os.path.join(WORK, 'scan_summary.json')
if os.path.exists(_summary_p):
    scan = json.load(open(_summary_p, encoding='utf-8'))

bad_subs = []
if scan is not None:
    for x in scan.get('subjects', []):
        if not (x.get('jsonl') and x.get('ok')):
            bad_subs.append(x.get('subject'))
else:
    # 没有 summary：退回按文件存在性判断
    bad_subs = [s for s in SUBJECTS if not os.path.exists(os.path.join(WORK, 'ch_%s.jsonl' % s))]

if bad_subs and not ALLOW_PARTIAL:
    sys.stderr.write('已阻止: 扫描数据不完整，缺/不可靠的学科: %s\n' % '、'.join(bad_subs))
    sys.stderr.write('  原因: 缺了这些学科，它们对应的格子会被误判成「该科汇总课程无此场章节」，\n')
    sys.stderr.write('        提案会静默少报 —— 而且报告看起来完全正常，看不出问题。\n')
    sys.stderr.write('  修正: bash exam_papers.sh <别名> reset\n')
    sys.stderr.write('        bash exam_papers.sh <别名> scan-courses\n')
    sys.stderr.write('  确要用残缺数据: 加 --allow-partial\n')
    sys.exit(3)

# 考试：四元组 -> 考试ID
exam_by_key, exam_names = {}, {}
for e in matrix:
    k = key_of(e.get('examName') or '')
    exam_names[e['exam']] = e.get('examName') or e.get('listName') or e['exam']
    if k:
        exam_by_key.setdefault(k, e['exam'])

# 各学科课程：考试ID -> (章节名, 试卷号)
src, unmapped = {}, []
unreliable_by_sub = {}
for sub in SUBJECTS:
    p = os.path.join(WORK, f'ch_{sub}.jsonl')
    if not os.path.exists(p):
        continue
    mp = os.path.join(WORK, 'ch_%s.meta.json' % sub)
    if os.path.exists(mp):
        try:
            u = json.load(open(mp, encoding='utf-8')).get('unreliable') or []
            if u:
                unreliable_by_sub[sub] = u
        except Exception:
            pass
    d = {}
    for o in load_jsonl(p):
        ch = o.get('chapter') or ''
        k = key_of(ch)
        if not k:
            unmapped.append((sub, ch, o.get('paper'), o.get('hasEntry')))
            continue
        eid = exam_by_key.get(k)
        if not eid:
            unmapped.append((sub, ch, o.get('paper'), o.get('hasEntry')))
            continue
        d[eid] = (ch, o.get('paper'))
    src[sub] = d

# ---------- 生成提案 ----------

def is_bound(v):
    return isinstance(v, str) and v.startswith('已绑')


proposals, gaps = [], []
for e in matrix:
    eid = e['exam']
    for sub in SUBJECTS:
        cur = (e.get('sub') or {}).get(sub, '—')
        if is_bound(cur):
            continue
        ch, paper = src.get(sub, {}).get(eid, (None, None))
        if ch is None:
            why = '该科汇总课程无此场章节' if sub in src else '未扫描该学科（本次数据缺失，不是真的没章节）'
        elif not paper:
            why = '试卷未录入（章节显示「催录题目」）'
        else:
            proposals.append({'examId': eid, 'examName': exam_names.get(eid, ''),
                              'subject': sub, 'chapter': ch, 'paper': paper})
            continue
        gaps.append({'examId': eid, 'examName': exam_names.get(eid, ''), 'subject': sub, 'why': why})

proposals.sort(key=lambda x: (x['subject'], x['examId']))
json.dump(proposals, open(os.path.join(WORK, 'proposals.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)

# ---------- 报告 ----------

L = []
L.append('# 绑卷提案与缺口报告\n')
if bad_subs:
    L.append('> ⚠️ **本次数据不完整**（--allow-partial）：缺/不可靠的学科 = %s。' % '、'.join(bad_subs))
    L.append('> 这些学科的"仍缺"结论不可信（会误报成「该科汇总课程无此场章节」），提案也可能少报。\n')
L.append(f'- 考试场次：{len(matrix)}')
L.append(f'- 可新增绑定：**{len(proposals)}** 条')
L.append(f'- 仍缺：{len(gaps)} 格\n')

L.append('## 一、可新增绑定提案\n')
if proposals:
    L.append('| 考试ID | 考试名 | 学科 | 试卷 | 来源章节 |')
    L.append('|---|---|---|---|---|')
    for p in proposals:
        L.append(f"| {p['examId']} | {p['examName']} | {p['subject']} | {p['paper']} | {p['chapter']} |")
else:
    L.append('（无）')

L.append('\n## 二、仍缺（按学科）\n')
for sub in SUBJECTS:
    rows = [g for g in gaps if g['subject'] == sub]
    if not rows:
        continue
    total_cells = len(matrix)
    bound = sum(1 for e in matrix if is_bound((e.get('sub') or {}).get(sub)))
    L.append(f'### {sub}（已绑 {bound}/{total_cells}，缺 {len(rows)}）')
    by = {}
    for g in rows:
        by.setdefault(g['why'], []).append(g['examId'])
    for why, ids in by.items():
        L.append(f'- {why}：{len(ids)} 场 → {", ".join(sorted(ids))}')
    L.append('')

_sec = 2
if unmapped:
    _sec += 1
    L.append(f'## {"三" if _sec == 3 else _sec}、⚠️ 无法自动归位的章节（未参与配对，需人工判断）\n')
    L.append('| 学科 | 章节名 | 试卷号 | 章节是否为空 |')
    L.append('|---|---|---|---|')
    for sub, ch, paper, has in unmapped:
        L.append(f"| {sub} | {ch} | {paper or '—'} | {'空(催录)' if has else '有内容'} |")
    L.append('')
    L.append('> 这些章节名推不出「学年+学期+年级+考试类型」，为免绑错**一律不自动配对**。')
    L.append('> 请人工确认它对应哪场考试后再单独用 `bind_paper.sh` 处理。\n')

if unreliable_by_sub:
    L.append('## ⚠️ 扫描时未取到的章节（该科数据不可靠，结果需复核）\n')
    L.append('| 学科 | 未取到的章节 |')
    L.append('|---|---|')
    for sub, chs in unreliable_by_sub.items():
        L.append(f"| {sub} | {', '.join(chs)} |")
    L.append('')
    L.append('> 这些章节在扫描时未能确认切章成功（name-mismatch / click-fail），')
    L.append('> 其卷号**可能取到了上一章的**（见坑 1、坑 2）。该学科的"仍缺"与提案都要人工复核。\n')

open(os.path.join(WORK, 'plan_report.md'), 'w', encoding='utf-8').write('\n'.join(L))

print(f'可新增绑定 {len(proposals)} 条，仍缺 {len(gaps)} 格'
      + (f'，另有 {len(unmapped)} 个章节无法自动归位' if unmapped else '')
      + (f'，{sum(len(v) for v in unreliable_by_sub.values())} 个章节扫描不可靠' if unreliable_by_sub else ''))
if bad_subs:
    print('⚠️ 本次数据不完整（--allow-partial），缺/不可靠学科: ' + '、'.join(bad_subs) + ' —— 结论不可信')
print('→ proposals.json / plan_report.md 已生成')
