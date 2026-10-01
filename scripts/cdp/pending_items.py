#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 scan_publish_state.js 的扫描结果生成「待发布清单」（items.jsonl）。

用法:
  python3 pending_items.py <scan.jsonl> <out_items.jsonl> [--exams 29194,29193] [--subjects 政治,语文] [--allow-disabled]

判定「待发布」= 有试卷编号(paper) 且 未发布(published=false) 且 发布按钮可点(pubDisabled=false)。

⚠️ 判定「已发布」只看行内有没有班级名（scan 里 published 字段），**不能**看是否出现「时间:」
   —— 考试级时间也会出现在尚未发布的学科行上。

⚠️ **完整性闸门**：若扫描结果里有任何一场考试带 `error`（如「页面未读到学科行」），
   本脚本**拒绝出清单**（退出码 5）。因为少一场考试照样能算出一份"看起来正常"的清单，
   只是静默少报——绑卷流水线踩过同样的坑（见 exam_papers.sh 的 require_complete_scan）。
   确要用残缺数据时显式加 `--allow-partial`。

输出 items.jsonl 每行: {"exam":"29194","examName":"…","sub":"政治","paper":"81951001"}
同时在 stderr 打印按学科统计，便于人工核对。
"""
import argparse
import json
import sys
from collections import Counter


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('scan')
    ap.add_argument('out')
    ap.add_argument('--exams', default='')
    ap.add_argument('--subjects', default='')
    ap.add_argument('--allow-disabled', action='store_true',
                    help='连「发布按钮灰掉」的格子也收进来（默认不收；收进来跑到会失败）')
    ap.add_argument('--allow-partial', action='store_true',
                    help='扫描有考试读取失败时仍出清单（默认拒绝，退出码 5）')
    a = ap.parse_args()

    only_ex = set(x.strip() for x in a.exams.split(',') if x.strip())
    only_sub = set(x.strip() for x in a.subjects.split(',') if x.strip())

    items, skipped_disabled, already, broken = [], [], [], []
    for line in open(a.scan, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        ex = rec.get('exam')
        if only_ex and ex not in only_ex:
            continue
        if rec.get('error') or not (rec.get('sub') or {}):
            broken.append((ex, rec.get('examName'), rec.get('error') or '无学科行'))
            if not a.allow_partial:
                continue
        for sub, v in (rec.get('sub') or {}).items():
            if only_sub and sub not in only_sub:
                continue
            if not isinstance(v, dict):
                continue
            paper = v.get('paper')
            if not paper:
                continue
            if v.get('published'):
                already.append((ex, sub, paper))
                continue
            if v.get('pubDisabled') and not a.allow_disabled:
                skipped_disabled.append((ex, sub, paper))
                continue
            items.append({'exam': ex, 'examName': rec.get('examName'),
                          'sub': sub, 'paper': paper})

    if broken:
        print('⚠️ 扫描不完整：%d 场考试没读到学科行' % len(broken), file=sys.stderr)
        for ex, nm, er in broken:
            print('     %s %s :: %s' % (ex, nm, er), file=sys.stderr)
        if not a.allow_partial:
            print('   → 已拒绝出清单（残缺数据会**静默少报**待发布项）。', file=sys.stderr)
            print('     修法: 只重扫这些考试并入扫描文件，或加 --allow-partial。', file=sys.stderr)
            print('     例: node scan_publish_state.js patch.jsonl %s' %
                  ','.join(x[0] for x in broken if x[0]), file=sys.stderr)
            return 5

    with open(a.out, 'w', encoding='utf-8') as f:
        for it in items:
            f.write(json.dumps(it, ensure_ascii=False) + '\n')

    print('[待发布] %d 条 -> %s' % (len(items), a.out), file=sys.stderr)
    c = Counter(it['sub'] for it in items)
    if c:
        print('  按学科: ' + '  '.join('%s=%d' % (k, c[k]) for k in sorted(c)), file=sys.stderr)
    ce = Counter(it['exam'] for it in items)
    if ce:
        print('  按考试: ' + '  '.join('%s=%d' % (k, ce[k]) for k in sorted(ce)), file=sys.stderr)
    if already:
        print('  (已发布跳过 %d 格)' % len(already), file=sys.stderr)
    if skipped_disabled:
        print('  ⚠️ 有卷但发布按钮灰掉、已跳过 %d 格:' % len(skipped_disabled), file=sys.stderr)
        for ex, sub, p in skipped_disabled:
            print('     %s %s %s' % (ex, sub, p), file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())

