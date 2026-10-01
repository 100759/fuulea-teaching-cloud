// 批量点「开始阅卷」
// 底层 == 前端 startSubjectMark(e) = GET /v2/exam/subject/<examSubjectId>/mark/  （返回 {} = 成功）
//
// 用法:
//   node start_mark.js <plan.json> <log.jsonl>                 # 空跑（默认）
//   node start_mark.js <plan.json> <log.jsonl> --limit 2 --yes # 真跑 2 条
//   node start_mark.js <plan.json> <log.jsonl> --yes           # 全量真跑
// 可叠加: --start N   --only <examId:subject,...>
//
// 护栏：
//   1) 目标只取 plan 里 state==='clickable' 的格子（= 有交卷数据、界面按钮可点）
//   2) 每条执行前**重新读一次 status**，!=15 一律跳过（幂等：已开始的不会再点）
//   3) 生产站必须显式 --yes；否则只空跑
//   4) 响应必须 HTTP 200 且 body 为 `{}`，否则记 fail（脚本最终非 0 退出）
//   5) 每 10 条刷新一次状态表，避免长跑期间读到旧状态
const { Api, loadCreds } = require('./api.js');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const [planPath, logPath] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (!planPath || !logPath) { console.error('用法: node start_mark.js <plan.json> <log.jsonl> [--dry|--yes] [--limit N] [--start N] [--only a:b,c:d]'); process.exit(2); }
  const argv = process.argv.slice(2);
  const yes = argv.includes('--yes');
  const dry = !yes || argv.includes('--dry');
  const num = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? Number(argv[i + 1]) : dflt; };
  const limit = num('--limit', Infinity);
  const startAt = num('--start', 0);
  const oi = argv.indexOf('--only');
  const only = oi >= 0 ? new Set(argv[oi + 1].split(',')) : null;

  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  let targets = plan.rows.filter(r => r.state === 'clickable');
  const totalClickable = targets.length;
  if (only) targets = targets.filter(r => only.has(r.examId + ':' + r.subject));
  console.error('# 基准 ' + planPath + '（' + (plan.at || '?') + '）');
  console.error('# state=clickable 共 ' + totalClickable + ' 条；本次目标 ' + targets.length + ' 条；dry=' + dry);

  const api = new Api(loadCreds());
  let statusMap = {};
  async function refreshStatus() {
    const m = {};
    for (let p = 1; p <= 5; p++) {
      const rr = await api.get('/v2/exam/', { role: 'grade', name: '', page: p });
      if (rr.status !== 200) break;
      const list = rr.json.results || [];
      if (!list.length) break;
      for (const ex of list) for (const es of (ex.examSubjects || [])) m[es.id] = es.status;
    }
    statusMap = m;
    return Object.keys(m).length;
  }
  const n = await refreshStatus();
  console.error('# 状态表 ' + n + ' 格');

  const log = [];
  let ok = 0, skip = 0, fail = 0;
  for (let i = startAt; i < targets.length && (i - startAt) < limit; i++) {
    const t = targets[i];
    if (i > startAt && (i - startAt) % 10 === 0) { await refreshStatus(); await sleep(300); }
    const tag = t.examId + ' ' + t.subject + ' (es=' + t.esId + ')';
    const cur = statusMap[t.esId];
    if (cur === undefined) { console.error('SKIP ' + tag + ' 状态读不到'); skip++; log.push({ ...t, result: 'skip-no-state' }); continue; }
    if (cur !== 15) { console.error('SKIP ' + tag + ' status=' + cur + '（已非待开始）'); skip++; log.push({ ...t, result: 'skip-status-' + cur }); continue; }
    if (dry) { console.log('DRY  ' + tag); continue; }

    let r;
    try { r = await api.get('/v2/exam/subject/' + t.esId + '/mark/'); }
    catch (e) { r = { status: -1, text: e.message }; }
    const body = String(r.text || '').trim();
    const good = r.status === 200 && (body === '{}' || body === '');
    if (good) { ok++; console.log('OK   ' + tag); } else { fail++; console.error('FAIL ' + tag + ' HTTP ' + r.status + ' ' + body.slice(0, 160)); }
    log.push({ ...t, result: good ? 'ok' : 'fail', http: r.status, body: body.slice(0, 200), at: new Date().toISOString() });
    await sleep(150);
  }

  if (dry) { console.log('\n（空跑结束，未执行任何写操作；真跑请加 --yes）'); return; }
  fs.appendFileSync(logPath, log.map(o => JSON.stringify(o)).join('\n') + '\n');
  console.log('\n=== 完成 ok=' + ok + ' skip=' + skip + ' fail=' + fail + ' ===  日志: ' + logPath);
  if (fail) process.exit(1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
