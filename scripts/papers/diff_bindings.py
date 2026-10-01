#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""操作前后矩阵比对：确认只改了预期的格子，没有解绑/错位/误伤

用法: python3 diff_bindings.py <before.jsonl> <after.jsonl> [proposals.json]

三条断言：
  1) 新增绑定 == proposals 里的清单（不多不少）
  2) 没有被解绑的格子
  3) 没有"本来就绑着、卷号却被换掉"的格子

⚠️ 前置：两份矩阵都必须是**完整扫描**的结果。若某场考试页面没打开成功
   （scan_matrix.js 会记 note:"open-blank"、sub 为空），那份矩阵里的该场
   所有格子都会显示成 "—"，diff 会误报成"被解绑"。所以这里先拦一道。
"""
import json, sys, os

def load(p):
    d = {}
    bad = []
    for line in open(p, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        o = json.loads(line)
        sub = o.get('sub') or {}
        # 扫描不全的信号：显式标记，或 9 科一个都没解析出来
        if o.get('note') or not sub:
            bad.append(o.get('exam'))
        d[o['exam']] = sub
    return d, bad


before, bad_b = load(sys.argv[1])
after, bad_a = load(sys.argv[2])
proposals_path = sys.argv[3] if len(sys.argv) > 3 else None

if bad_b or bad_a:
    print('❌ 基线与结果里存在"未成功扫描"的考试，diff 结论不可信，已中止：')
    if bad_b:
        print('   before 未扫到: ' + ', '.join(map(str, bad_b)))
    if bad_a:
        print('   after  未扫到: ' + ', '.join(map(str, bad_a)))
    print('   先跑: bash exam_papers.sh <别名> reset && bash exam_papers.sh <别名> audit')
    sys.exit(2)

add, rm, chg = [], [], []
for exam in sorted(set(before) | set(after)):
    b, a = before.get(exam, {}), after.get(exam, {})
    for s in sorted(set(b) | set(a)):
        bv, av = b.get(s, '—'), a.get(s, '—')
        if bv == av:
            continue
        if bv == '未绑' and str(av).startswith('已绑'):
            add.append((exam, s, str(av).split()[-1]))
        elif str(bv).startswith('已绑') and av == '未绑':
            rm.append((exam, s, bv))
        else:
            chg.append((exam, s, bv, av))

print(f'== 新增绑定 {len(add)} 条 ==')
for e, s, v in add:
    print(f'  + {e}  {s}  {v}')

if rm:
    print(f'\n== ⚠️ 被解绑 {len(rm)} 条 ==')
    for e, s, v in rm:
        print(f'  - {e}  {s}  原 {v}')
else:
    print('\n== 无解绑 ==')

if chg:
    print(f'\n== ⚠️ 卷号被改动 {len(chg)} 条 ==')
    for e, s, bv, av in chg:
        print(f'  ! {e}  {s}  {bv} -> {av}')
else:
    print('== 无卷号变更 ==')

ok = True
if proposals_path and os.path.exists(proposals_path):
    props = json.load(open(proposals_path, encoding='utf-8'))
    exp = {(p['examId'], p['subject'], str(p['paper'])) for p in props}
    got = set(add)
    miss, extra = exp - got, got - exp
    print(f'\n== 与提案核对（预期 {len(exp)} 条）==')
    if not miss and not extra:
        print('  ✅ 完全一致')
    else:
        ok = False
        for m in sorted(miss):
            print(f'  ❌ 预期但未成功: {m}')
        for x in sorted(extra):
            print(f'  ⚠️ 预期外新增: {x}')

if rm or chg:
    ok = False

print('\n结论: ' + ('✅ 通过（只改了预期内容）' if ok else '❌ 需人工复查'))
sys.exit(0 if ok else 1)
