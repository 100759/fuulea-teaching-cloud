#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""发布前后逐格 diff：确认只改了预期内容。

用法:
  python3 diff_publish_state.py <before.jsonl> <after.jsonl> <items.jsonl> [--expect-time "MM-dd HH:mm - MM-dd HH:mm"]

三项检查（任一不满足即 exit 1）:
  ① 新增发布 == items 清单（不多不少）
  ② 没有被"取消发布"的格子（原本已发布 → 现在未发布）
  ③ 没有卷号被改动的格子
另外统计每条新增的发布班级数（只记录，**不判定**——服务端会按学科收窄班级，见 SOP）。
"""
import argparse
import json
import sys
from collections import Counter


def load(path):
    d = {}
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        for sub, v in (r.get('sub') or {}).items():
            if isinstance(v, dict):
                d[(r.get('exam'), sub)] = v
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('before')
    ap.add_argument('after')
    ap.add_argument('items')
    ap.add_argument('--expect-time', default='')
    a = ap.parse_args()

    b = load(a.before)
    af = load(a.after)
    want = set()
    want_paper = {}
    for line in open(a.items, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        it = json.loads(line)
        k = (it['exam'], it['sub'])
        want.add(k)
        want_paper[k] = str(it.get('paper', ''))

    gained, lost, changed, timebad = [], [], [], []
    for k, v in af.items():
        ob = b.get(k) or {}
        was = bool(ob.get('published'))
        now = bool(v.get('published'))
        if now and not was:
            gained.append(k)
            if a.expect_time and v.get('time') != a.expect_time:
                timebad.append((k, v.get('time')))
        if was and not now:
            lost.append(k)
        if ob.get('paper') and v.get('paper') and ob['paper'] != v['paper']:
            changed.append((k, ob['paper'], v['paper']))

    gset = set(gained)
    extra = gset - want                 # 发布了清单外的
    missed = want - gset                # 清单里没发成的
    wrongpaper = [(k, want_paper[k], (af.get(k) or {}).get('paper')) for k in gained
                  if want_paper.get(k) and (af.get(k) or {}).get('paper') != want_paper[k]]

    print('== 新增发布 %d 条（清单 %d 条）==' % (len(gained), len(want)))
    if extra:
        print('  ⚠️ 多发了 %d 条（清单外）:' % len(extra))
        for k in sorted(extra):
            print('     %s %s' % k)
    if missed:
        print('  ⚠️ 清单里未发成 %d 条:' % len(missed))
        for k in sorted(missed):
            print('     %s %s' % k)
    if not extra and not missed:
        print('  ✅ 与清单完全一致')
    print('== 被取消发布: %d ==' % len(lost))
    for k in lost:
        print('     %s %s' % k)
    print('== 卷号被改动: %d ==' % len(changed))
    for k, o, n in changed:
        print('     %s %s  %s -> %s' % (k[0], k[1], o, n))
    if wrongpaper:
        print('  ⚠️ 发布后卷号与清单不符 %d 条:' % len(wrongpaper))
        for k, wp, gp in wrongpaper:
            print('     %s %s  期望 %s 实际 %s' % (k[0], k[1], wp, gp))

    if gained:
        cc = Counter((af[k] or {}).get('classCount') for k in gained)
        print('== 新增条目的真实班级数分布（只记录，不判定）==')
        print('  ' + '  '.join('%s个班=%d' % (k, cc[k]) for k in sorted(cc, key=lambda x: (x is None, x))))

    timed = ''
    if a.expect_time:
        print('== 时间校验（期望 %s）: %d 条不符 ==' % (a.expect_time, len(timebad)))
        for k, t in timebad:
            print('     %s %s  实际 %s' % (k[0], k[1], t))
        timed = bool(timebad)

    ok = not (extra or missed or lost or changed or wrongpaper or timed)
    print()
    print('结论: %s' % ('✅ 通过（只改了预期内容）' if ok else '❌ 未通过，需人工复查'))
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
