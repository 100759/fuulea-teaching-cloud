// 只读：全站扫描「开始阅卷」可点性 → 出 plan.json
//
// 用法: node mark_plan.js <out.json> [--allow-partial]
//
// 判定规则（2026-10-01 全站 153 格实测，与界面按钮态 153/153 一致）：
//   status=0   未绑卷                    → state=unbound      （界面：制作答题卡 / 关联已有试卷）
//   status=111 已发布 + 阅卷进度 100%     → state=done-111     （界面：重新阅卷）
//   status=47  已开始阅卷（mark 已调过）   → state=started-47   （界面：结束阅卷）
//   status=15  已发布但未开始：
//        scan/progress 任一班 submitCount>0 → state=clickable     （界面：「开始阅卷」可点）
//        全部 submitCount=0                 → state=gray-no-submit（界面：「开始阅卷」灰色）
//   其他 status → state=status-<n>（未知，报告出来别猜）
//
// **不需要浏览器**。`scan/progress` 的 submitCount 就是「有无交卷数据」的权威值。
const { Api, loadCreds } = require('./api.js');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const out = process.argv[2];
  const allowPartial = process.argv.includes('--allow-partial');
  if (!out) { console.error('用法: node mark_plan.js <out.json> [--allow-partial]'); process.exit(2); }

  const api = new Api(loadCreds());
  const exams = [];
  for (let p = 1; p <= 5; p++) {
    const r = await api.get('/v2/exam/', { role: 'grade', name: '', page: p });
    if (r.status !== 200) { if (p === 1) { console.error('考试清单读取失败 HTTP ' + r.status + ' ' + r.text.slice(0, 120)); process.exit(1); } break; }
    const list = r.json.results || r.json.data || [];
    if (!list.length) break;
    exams.push(...list);
  }

  const rows = [];
  let errs = 0;
  for (const ex of exams) {
    for (const es of (ex.examSubjects || [])) {
      const row = {
        examId: ex.id, examName: ex.name, esId: es.id,
        subject: es.subject ? es.subject.name : '?', status: es.status,
        submitTotal: null, sumTotal: null, state: null,
      };
      if (es.status === 15) {
        const s = await api.get('/v2/exam/subject/' + es.id + '/scan/progress/');
        let sub = 0, sum = 0, okRead = false;
        if (s.status === 200 && s.json && Array.isArray(s.json.classroomPercent)) {
          okRead = true;
          for (const c of s.json.classroomPercent) { sub += (c.submitCount || 0); sum += (c.sumCount || 0); }
        }
        if (!okRead) { errs++; row.state = 'scan-error-' + s.status; }
        else { row.submitTotal = sub; row.sumTotal = sum; row.state = sub > 0 ? 'clickable' : 'gray-no-submit'; }
        await sleep(60);
      } else if (es.status === 0) row.state = 'unbound';
      else if (es.status === 111) row.state = 'done-111';
      else if (es.status === 47) row.state = 'started-47';
      else { row.state = 'status-' + es.status; errs++; }
      rows.push(row);
    }
  }

  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), base: process.env.FUULEA_BASE || 'https://lyyz.fuulea.com', rows }, null, 1));
  const byState = {};
  for (const r of rows) byState[r.state] = (byState[r.state] || 0) + 1;
  console.error('扫描完成: exams=' + exams.length + ' cells=' + rows.length + ' ' + JSON.stringify(byState));
  if (errs && !allowPartial) { console.error('完整性闸门：有 ' + errs + ' 格没读全，拒绝当基准（加 --allow-partial 可强出）'); process.exit(5); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
