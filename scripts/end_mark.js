// 批量「结束阅卷」
// 底层 == 详情页学科行按钮「结束阅卷」= POST /v2/exam/subject/<examSubjectId>/finish/
//   前置条件（前端判断）：(status & STATUS_HAS_ANSWER(2)) > 0，否则报「尚未进行答案设置」
//   成功返回 {"detail":null}；执行后 status: 47(已开始阅卷) → 111(已结束阅卷)
//
// 用法:
//   node end_mark.js [--dry] [--limit N] [--start N] [--only <examId:subject,...>]
//   真跑必须带 --yes
//
// 护栏：目标只取「当前 status===47」的格子（= 已开始阅卷未结束）；每条执行前重读 status，已非 47 跳过。
const { Api, loadCreds } = require('./api.js');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const argv = process.argv.slice(2);
  const yes = argv.includes('--yes');
  const dry = !yes || argv.includes('--dry');
  const num = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? Number(argv[i + 1]) : d; };
  const limit = num('--limit', Infinity);
  const startAt = num('--start', 0);
  const oi = argv.indexOf('--only');
  const only = oi >= 0 ? new Set(argv[oi + 1].split(',')) : null;
  const logPath = num('--log', null) || (argv[argv.indexOf('--log') + 1] || '/tmp/end_mark_log.jsonl');

  const api = new Api(loadCreds());
  let rows = [];
  let statusMap = {};
  async function refresh() {
    rows = []; statusMap = {};
    for (let p = 1; p <= 5; p++) {
      const r = await api.get('/v2/exam/', { role: 'grade', name: '', page: p });
      if (r.status !== 200) break;
      const list = r.json.results || [];
      if (!list.length) break;
      for (const ex of list) for (const es of (ex.examSubjects || [])) {
        statusMap[es.id] = es.status;
        rows.push({ examId: ex.id, examName: ex.name, esId: es.id, subject: es.subject ? es.subject.name : '?', status: es.status });
      }
    }
  }
  await refresh();
  let targets = rows.filter(r => r.status === 47);
  if (only) targets = targets.filter(r => only.has(r.examId + ':' + r.subject));
  console.error('# 当前 status=47（已开始阅卷未结束）共 ' + targets.length + ' 条；本次目标 ' + Math.min(limit, targets.length - startAt) + ' 条；dry=' + dry);

  const log = [];
  let ok = 0, skip = 0, fail = 0;
  for (let i = startAt; i < targets.length && (i - startAt) < limit; i++) {
    const t = targets[i];
    if (i > startAt && (i - startAt) % 10 === 0) { await refresh(); await sleep(300); }
    const tag = t.examId + ' ' + t.subject + ' (es=' + t.esId + ')';
    if (statusMap[t.esId] !== 47) { console.error('SKIP ' + tag + ' status=' + statusMap[t.esId]); skip++; log.push({ ...t, result: 'skip-status-' + statusMap[t.esId] }); continue; }
    if (dry) { console.log('DRY  ' + tag); continue; }
    let r;
    try { r = await api.postJson('/v2/exam/subject/' + t.esId + '/finish/'); }
    catch (e) { r = { status: -1, text: e.message }; }
    const body = String(r.text || '').trim();
    const good = r.status === 200 && !/"detail"\s*:\s*"[^"]/.test(body);
    if (good) { ok++; console.log('OK   ' + tag + '  ' + body); } else { fail++; console.error('FAIL ' + tag + ' HTTP ' + r.status + ' ' + body.slice(0, 160)); }
    log.push({ ...t, result: good ? 'ok' : 'fail', http: r.status, body: body.slice(0, 200), at: new Date().toISOString() });
    statusMap[t.esId] = 111;
    await sleep(150);
  }
  if (dry) { console.log('\n（空跑结束；真跑请加 --yes）'); return; }
  fs.appendFileSync(logPath, log.map(o => JSON.stringify(o)).join('\n') + '\n');
  console.log('\n=== 完成 ok=' + ok + ' skip=' + skip + ' fail=' + fail + ' ===  日志: ' + logPath);
  if (fail) process.exit(1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
