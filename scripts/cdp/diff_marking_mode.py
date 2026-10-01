#!/usr/bin/env python3
"""阅卷分配模式 before/after 逐条 diff（只读，不改数据）

用法:
    python3 diff_marking_mode.py <before.jsonl> <after.jsonl> [--expect 任务阅卷]

判据（退出码非 0 即不通过）:
  ① after 里没有任何格子比 before 更"退"（任务阅卷 不应变回 考试阅卷）
  ② 变化条数 == 预期条数（--expect-count，可选）
  ③ 所有变化的方向都是 before -> --expect（默认 任务阅卷）
  ④ after 里的失败项 / 未知项必须为 0

为什么要有这个脚本：阅卷分配是**不可逆**设置，改完必须逐条对账，
而不是"看几条没问题就算过"。
"""
import json
import sys
from collections import Counter

EXIT_OK, EXIT_DIFF, EXIT_BADARGS = 0, 1, 2


def load(path):
    out = {}
    with open(path, encoding='utf-8') as f:
        for line in f:
            if line.strip():
                r = json.loads(line)
                out[(r['exam'], r['sub'])] = r
    return out


def main():
    args = [a for a in sys.argv[1:]]
    if len(args) < 2:
        print(__doc__)
        return EXIT_BADARGS
    before, after = args[0], args[1]
    expect = '任务阅卷'
    expect_count = None
    if '--expect' in args:
        expect = args[args.index('--expect') + 1]
    if '--expect-count' in args:
        expect_count = int(args[args.index('--expect-count') + 1])

    b, a = load(before), load(after)
    print('before %d 条 / after %d 条' % (len(b), len(a)))

    only_after = sorted(set(a) - set(b))
    missing = sorted(set(b) - set(a))
    if only_after:
        print('  ⚠️ 只在 after 出现:', only_after)
    if missing:
        print('  ⚠️ 只在 before 出现:', missing)

    errs = [(k, v.get('err')) for k, v in a.items() if v.get('err')]
    unknown = [(k, v.get('radios')) for k, v in a.items() if v.get('mode') == '未知']

    changed, same, backward = [], [], []
    for k in sorted(set(b) & set(a)):
        mb, ma = b[k].get('mode'), a[k].get('mode')
        if mb == ma:
            same.append(k)
        else:
            changed.append((k, mb, ma))
            if mb == expect and ma != expect:
                backward.append((k, mb, ma))

    print('\n== 变化 %d 条 ==' % len(changed))
    for k, mb, ma in changed:
        print('   %s %s : %s -> %s' % (k[0], k[1], mb, ma))
    print('== 未变化 %d 条 ==' % len(same))
    print('== after 分布: %s ==' % dict(Counter(v.get('mode') for v in a.values())))
    if errs:
        print('== ⚠️ 读取失败 %d 条 ==' % len(errs))
        for k, e in errs:
            print('   %s %s : %s' % (k[0], k[1], e))
    if unknown:
        print('== ⚠️ 状态未知 %d 条（radio 未渲染，需重测）==' % len(unknown))
        for k, r in unknown:
            print('   %s %s : %r' % (k[0], k[1], r))

    bad = []
    if backward:
        bad.append('存在"改回退"的格子 %d 条' % len(backward))
    if errs or unknown:
        bad.append('存在读不到状态的格子（失败 %d / 未知 %d）' % (len(errs), len(unknown)))
    if expect_count is not None and len(changed) != expect_count:
        bad.append('变化条数 %d ≠ 预期 %d' % (len(changed), expect_count))
    if only_after or missing:
        bad.append('前后条目集合不一致')

    print()
    if bad:
        print('结论: ❌ 不通过')
        for x in bad:
            print('   - ' + x)
        return EXIT_DIFF
    print('结论: ✅ 通过（%d 条 %s → %s，无回退、无读取异常）' % (len(changed), expect, expect))
    return EXIT_OK


if __name__ == '__main__':
    sys.exit(main())
