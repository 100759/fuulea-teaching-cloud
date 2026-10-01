#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""全站考试「三类缺口」对账台账 —— 一次性回答：
    ① 哪些考试的学科**没绑定试卷**
    ② 哪些**绑了但没发布**
    ③ 哪些**发布了但没改成任务阅卷**

⚠️ 已过时（2026-10-01）：请改用 `scripts/scan_exam_cells.js` + `scripts/gap_report.py`。
   那条链路**直连 /v2 接口**（`subjects` 拿发布状态、`marker` 拿 markByTask），
   全站 153 格约 30 秒跑完、0 失败；本脚本依赖界面扫描产物，慢且会被渲染竞态污染
   （实测 40+ 分钟、多格 ERR、还出现过假阴性）。保留仅供"没有接口权限"时兜底。

用法:
    python3 report_gap_audit.py <scan.jsonl> [<marking.jsonl>] \
        [--out-md report.md] [--out-xlsx report.xlsx] [--subjects-per-exam 9]

输入:
  scan.jsonl      = scripts/cdp/scan_publish_state.js 的产物（已合并补扫）
  marking.jsonl   = scripts/cdp/scan_marking_mode.js 的产物（可选；不给就跳过 ③）

⚠️ 本脚本**不做写操作**，也不替你判断"该不该改"。它只负责把三类缺口列清楚。

⚠️ 前置完整性：scan 里若有考试带 `error`（页面未读到学科行），本脚本会**显著标红**并
   以退出码 5 结束 —— 因为少一场考试照样能算出一份"看起来正常"的台账，只是静默少报。
   正确做法是先补扫那一场再合并（`node scan_publish_state.js patch.jsonl <考试ID>`）。
"""
import argparse
import json
import os
import sys
from collections import Counter

EXIT_OK, EXIT_INCOMPLETE, EXIT_BADARGS = 0, 5, 2


def load_jsonl(path):
    out = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('scan')
    ap.add_argument('marking', nargs='?', default=None)
    ap.add_argument('--out-md', default=None)
    ap.add_argument('--out-xlsx', default=None)
    ap.add_argument('--subjects-per-exam', type=int, default=9,
                    help='每场考试应有的学科数（默认 9；用于判"整场缺失"）')
    a = ap.parse_args()

    if not os.path.exists(a.scan):
        print('找不到扫描文件: %s' % a.scan, file=sys.stderr)
        return EXIT_BADARGS

    scan = load_jsonl(a.scan)
    unread = [(r.get('exam'), r.get('examName'), r.get('error')) for r in scan
              if r.get('error') or not (r.get('sub') or {})]

    unbound, bound_unpub, published = [], [], []
    for r in scan:
        ex, nm = r.get('exam'), r.get('examName')
        subs = r.get('sub') or {}
        for sub, v in subs.items():
            if not isinstance(v, dict):
                continue
            if not v.get('paper'):
                unbound.append({'exam': ex, 'examName': nm, 'sub': sub,
                                'note': '该科无试卷（多为平台显示「催录题目」= 源头未录）'})
            elif not v.get('published'):
                bound_unpub.append({'exam': ex, 'examName': nm, 'sub': sub,
                                    'paper': v.get('paper'),
                                    'note': '有卷未发布'})
            else:
                published.append({'exam': ex, 'examName': nm, 'sub': sub,
                                  'paper': v.get('paper'),
                                  'time': v.get('time'), 'classCount': v.get('classCount')})

    total_cells = sum(len(r.get('sub') or {}) for r in scan)

    # ③ 已发布但非任务阅卷
    not_task, mark_unknown, mark_err, task_cnt = [], [], [], 0
    if a.marking and os.path.exists(a.marking):
        pub_index = {(c['exam'], c['sub']): c for c in published}
        for m in load_jsonl(a.marking):
            k = (m.get('exam'), m.get('sub'))
            base = pub_index.get(k, {})
            rec = {'exam': m.get('exam'), 'examName': base.get('examName') or m.get('examName'),
                   'sub': m.get('sub'), 'paper': base.get('paper') or m.get('paper'),
                   'mode': m.get('mode'), 'examStatus': m.get('examStatus')}
            if m.get('err'):
                rec['note'] = '读取失败：%s' % m['err']
                mark_err.append(rec)
            elif m.get('mode') == '任务阅卷':
                task_cnt += 1
            elif m.get('mode') == '考试阅卷':
                rec['note'] = '仍是考试阅卷'
                not_task.append(rec)
            else:
                rec['note'] = '状态未知（radio 未渲染，需重测）'
                mark_unknown.append(rec)

    # ---------- 输出 ----------
    L = []
    L.append('# 考试配置全站对账台账')
    L.append('')
    L.append('- 考试场次：**%d**' % len(scan))
    L.append('- 学科格总数：**%d**（每场应 %d 个）' % (total_cells, a.subjects_per_exam))
    L.append('- 未绑定：**%d**' % len(unbound))
    L.append('- 已绑定未发布：**%d**' % len(bound_unpub))
    L.append('- 已发布：**%d**' % len(published))
    if a.marking:
        L.append('- 已发布中「任务阅卷」：**%d**；**未改任务阅卷：%d**（考试阅卷 %d / 未知 %d / 读取失败 %d）'
                 % (task_cnt, len(not_task) + len(mark_unknown) + len(mark_err),
                    len(not_task), len(mark_unknown), len(mark_err)))
    L.append('')

    if unread:
        L.append('## ⚠️ 扫描不完整（先补扫再解读本表）')
        L.append('')
        L.append('| 考试ID | 考试名 | 原因 |')
        L.append('|---|---|---|')
        for ex, nm, er in unread:
            L.append('| %s | %s | %s |' % (ex, nm, er or '无学科行'))
        L.append('')
        L.append('> 补扫：`node scan_publish_state.js patch.jsonl %s`，再把结果合并进扫描文件。'
                 % ','.join(str(x[0]) for x in unread if x[0]))
        L.append('')

    def table(title, rows, cols, empty_msg):
        L.append('## %s' % title)
        L.append('')
        if not rows:
            L.append('✅ %s' % empty_msg)
            L.append('')
            return
        L.append('| ' + ' | '.join(c[0] for c in cols) + ' |')
        L.append('|' + '---|' * len(cols))
        for r in rows:
            L.append('| ' + ' | '.join(str(r.get(c[1], '') or '') for c in cols) + ' |')
        L.append('')

    table('① 未绑定试卷的学科', unbound,
          [('考试ID', 'exam'), ('考试名', 'examName'), ('学科', 'sub'), ('说明', 'note')],
          '没有未绑定的学科')
    table('② 已绑定但未发布的学科', bound_unpub,
          [('考试ID', 'exam'), ('考试名', 'examName'), ('学科', 'sub'), ('试卷', 'paper'), ('说明', 'note')],
          '没有"绑了没发"的学科')
    if a.marking:
        table('③ 已发布但**未改为任务阅卷**的学科', not_task + mark_unknown + mark_err,
              [('考试ID', 'exam'), ('考试名', 'examName'), ('学科', 'sub'),
               ('试卷', 'paper'), ('当前模式', 'mode'), ('说明', 'note')],
              '所有已发布学科都是任务阅卷')

    # 按考试汇总
    L.append('## 按考试汇总（每场 %d 格）' % a.subjects_per_exam)
    L.append('')
    L.append('| 考试ID | 考试名 | 已发布 | 已绑未发布 | 未绑定 | 非任务阅卷 |')
    L.append('|---|---|---|---|---|---|')
    nt = Counter((r['exam']) for r in (not_task + mark_unknown + mark_err))
    for r in scan:
        ex = r.get('exam')
        subs = r.get('sub') or {}
        p = sum(1 for v in subs.values() if isinstance(v, dict) and v.get('published'))
        b = sum(1 for v in subs.values() if isinstance(v, dict) and v.get('paper') and not v.get('published'))
        u = sum(1 for v in subs.values() if isinstance(v, dict) and not v.get('paper'))
        L.append('| %s | %s | %d | %d | %d | %d |'
                 % (ex, r.get('examName'), p, b, u, nt.get(ex, 0) if a.marking else 0))
    L.append('')

    text = '\n'.join(L)
    if a.out_md:
        with open(a.out_md, 'w', encoding='utf-8') as f:
            f.write(text + '\n')
        print('报告 -> %s' % a.out_md, file=sys.stderr)

    if a.out_xlsx:
        try:
            import openpyxl
            from openpyxl.styles import Font, Alignment, PatternFill

            wb = openpyxl.Workbook()
            hdr_fill = PatternFill('solid', fgColor='DDEBF7')
            hdr_font = Font(bold=True)

            def sheet(name, cols, rows):
                ws = wb.create_sheet(name)
                ws.append([c[0] for c in cols])
                for c in ws[1]:
                    c.fill = hdr_fill
                    c.font = hdr_font
                    c.alignment = Alignment(horizontal='center')
                for r in rows:
                    ws.append([r.get(c[1], '') for c in cols])
                for i, c in enumerate(cols, 1):
                    ws.column_dimensions[openpyxl.utils.get_column_letter(i)].width = \
                        max(12, min(40, max([len(str(c[0]))] + [len(str(r.get(c[1], '') or '')) for r in rows] or [10]) + 4))
                ws.freeze_panes = 'A2'
                return ws

            wb.remove(wb.active)
            sheet('①未绑定', [('考试ID', 'exam'), ('考试名', 'examName'), ('学科', 'sub'), ('说明', 'note')], unbound)
            sheet('②已绑未发布', [('考试ID', 'exam'), ('考试名', 'examName'), ('学科', 'sub'), ('试卷', 'paper'), ('说明', 'note')], bound_unpub)
            if a.marking:
                sheet('③非任务阅卷', [('考试ID', 'exam'), ('考试名', 'examName'), ('学科', 'sub'),
                                     ('试卷', 'paper'), ('当前模式', 'mode'), ('说明', 'note')],
                      not_task + mark_unknown + mark_err)
            ov = []
            nt = Counter((r['exam']) for r in (not_task + mark_unknown + mark_err))
            for r in scan:
                subs = r.get('sub') or {}
                ov.append({'exam': r.get('exam'), 'examName': r.get('examName'),
                           'published': sum(1 for v in subs.values() if isinstance(v, dict) and v.get('published')),
                           'boundUnpub': sum(1 for v in subs.values() if isinstance(v, dict) and v.get('paper') and not v.get('published')),
                           'unbound': sum(1 for v in subs.values() if isinstance(v, dict) and not v.get('paper')),
                           'notTask': nt.get(r.get('exam'), 0) if a.marking else 0})
            sheet('总览', [('考试ID', 'exam'), ('考试名', 'examName'), ('已发布', 'published'),
                          ('已绑未发布', 'boundUnpub'), ('未绑定', 'unbound'), ('非任务阅卷', 'notTask')], ov)
            wb.save(a.out_xlsx)
            print('表格 -> %s' % a.out_xlsx, file=sys.stderr)
        except ImportError:
            print('⚠️ 未安装 openpyxl，跳过 xlsx 输出（md 已生成）', file=sys.stderr)

    print(text)
    return EXIT_INCOMPLETE if unread else EXIT_OK


if __name__ == '__main__':
    sys.exit(main())
