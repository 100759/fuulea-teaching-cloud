// 批量「公布成绩」/「撤回成绩」
// 底层 == 详情页学科行按钮 = POST /v2/exam/<examId>/show-answer/  body {examSubjectId, action}
//   action="show" → 公布成绩（成功 HTTP 201，空 body；showAnswerAt 由占位未来时间变为当前时间）
//   action="hide" → 撤回成绩
//
// 前置条件（前端判断）：该科 status 已含 STATUS_MARKED（= 已结束阅卷，后端值 111）
// 判定「当前是公布态还是撤回态」：看该科 showAnswerAt
//   showAnswerAt 为 null 或在**将来**（平台占位 2029-09-12…）→ 未公布，按钮是「公布成绩」
//   showAnswerAt 在**过去** → 已公布，按钮是「撤回成绩」
//
// 用法:
//   node show_answer.js [--action show|hide] [--dry] [--limit N] [--start N] [--only <examId:subject,...>] [--log <file>]
//   真跑必须 --yes
//
// 护栏：每条执行前重新读该科 subjects 详情，status 必须为 111，且 showAnswerAt 方向必须与 --action 匹配，否则跳过。
const { Api, loadCreds } = require('./api.js');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const argv = process.argv.slice(2);
  const yes = argv.includes('--yes');
  const dry = !yes || argv.includes('--dry');
  const num = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? Number(argv[i + 1]) : d; };
  const str = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const action = str('--action', 'show');           // show = 公布成绩, hide = 撤回成绩
  const limit = num('--limit', Infinity);
  const startAt = num('--start', 0);
  const oi = argv.indexOf('--only');
  const only = oi >= 0 ? new Set(argv[oi + 1].split(',')) : null;
  const logPath = str('--log', '/tmp/show_answer_log.jsonl');
  const wantFuture = action === 'show';             // show → 要求 showAnswerAt 是将来/null

  const api = new Api(loadCreds());

  // 1) 拉考试清单
  const exams = [];
  for (let p = 1; p <= 5; p++) {
    const r = await api.get('/v2/exam/', { role: 'grade', name: '', page: p });
    if (r.status !== 200) break;
    const list = r.json.results || [];
    if (!list.length) break;
    exams.push(...list);
  }

  // 2) 拉每场考试学科详情，筛出 已结束阅卷(111) 且 公布方向匹配 的格子
  const targets = [];
  const skipped = [];
  for (const ex of exams) {
    const r = await api.get('/v2/exam/' + ex.id + '/subjects/');
    if (r.status !== 200) { skipped.push('exam ' + ex.id + ' HTTP ' + r.status); continue; }
    for (const es of (r.json.data || [])) {
      const name = es.subject ? es.subject.name : '?';
      const sAt = es.showAnswerAt ? new Date(es.showAnswerAt) : null;
      const future = !sAt || sAt.getTime() > Date.now();
      const item = { examId: ex.id, examName: ex.name, esId: es.id, subject: name, status: es.status, showAnswerAt: es.showAnswerAt, action };
      if (es.status !== 111) { continue; }
      if (future !== wantFuture) { continue; }
      if (only && !only.has(ex.id + ':' + name)) continue;
      targets.push(item);
    }
    await sleep(60);
  }
  console.error('# action=' + action + ' 目标 ' + targets.length + ' 条；dry=' + dry);

  const log = [];
  let ok = 0, skip = 0, fail = 0;
  for (let i = startAt; i < targets.length && (i - startAt) < limit; i++) {
    const t = targets[i];
    const tag = t.examId + ' ' + t.subject + ' (es=' + t.esId + ')';
    // 执行前复核
    const rr = await api.get('/v2/exam/' + t.examId + '/subjects/');
    const cur = (rr.json && rr.json.data || []).find(e => e.id === t.esId);
    if (!cur) { console.error('SKIP ' + tag + ' 读不到'); skip++; log.push({ ...t, result: 'skip-no-state' }); continue; }
    if (cur.status !== 111) { console.error('SKIP ' + tag + ' status=' + cur.status + '（未结束阅卷）'); skip++; log.push({ ...t, result: 'skip-status-' + cur.status }); continue; }
    const cs = cur.showAnswerAt ? new Date(cur.showAnswerAt) : null;
    if ((!cs || cs.getTime() > Date.now()) !== wantFuture) { console.error('SKIP ' + tag + ' 公布方向不符 showAnswerAt=' + cur.showAnswerAt); skip++; log.push({ ...t, result: 'skip-direction' }); continue; }
    if (dry) { console.log('DRY  ' + tag); continue; }

    let r;
    try { r = await api.postJson('/v2/exam/' + t.examId + '/show-answer/', { examSubjectId: t.esId, action }); }
    catch (e) { r = { status: -1, text: e.message }; }
    const good = (r.status === 200 || r.status === 201) && !String(r.text || '').trim();
    if (good) { ok++; console.log('OK   ' + tag); } else { fail++; console.error('FAIL ' + tag + ' HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 160)); }
    log.push({ ...t, result: good ? 'ok' : 'fail', http: r.status, body: String(r.text || '').slice(0, 200), at: new Date().toISOString() });
    await sleep(150);
  }

  if (!dry) {
    fs.appendFileSync(logPath, log.map(o => JSON.stringify(o)).join('\n') + '\n');
    console.log('\n=== 完成 action=' + action + ' ok=' + ok + ' skip=' + skip + ' fail=' + fail + ' ===  日志: ' + logPath);
    if (fail) process.exit(1);
  } else {
    console.log('\n（空跑结束；真跑请加 --yes）');
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
