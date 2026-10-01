// 全站「考试 × 学科」格子普查（只读，直连 /v2，不用浏览器）。
//
// 一次拿齐三类缺口所需的全部字段：
//   ① 未绑定试卷   —— subjects 接口 paper == null
//   ② 已绑未发布   —— publishedAt == null
//   ③ 阅卷分配模式 —— 逐格调 /v2/exam/subject/<examSubjectId>/marker/ 取 markByTask
//
// 用法:
//   node scan_exam_cells.js <out.jsonl> [--exams 29194,29193] [--pages 3] [--allow-partial]
//
// 前置: bash scripts/login.sh <别名> && node scripts/api.js creds
//
// 输出: 每行一格 {exam, examName, grade, sub, examSubjectId, paper, publishedAt, status,
//                 classroomCount, studentCount, markPercent, markByTask, markType, ...}
// 完整性闸门: 有任何一格没取到 → 写 <out>.summary.json 并 **退出码 5**（除非 --allow-partial）。
//            别拿半份数据去生成"看起来正常"的报告。
//
// 状态码语义（2026-10-01 全站 153 格实测，与界面读数 100% 一致）:
//   0   未绑定试卷
//   11  已发布（分配=考试阅卷）
//   15  已发布（分配=任务阅卷）
//   111 已发布 + 阅卷进度 100%，此时「阅卷分配」按钮被系统禁用（模式仍可由 marker 接口读到）
const fs = require('fs');
const SK = __dirname;
const { Api, loadCreds } = require(SK + '/api.js');

const argv = process.argv.slice(2);
const outPath = argv[0] || '/tmp/fuulea/exam_cells.jsonl';
const getFlag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const allowPartial = argv.includes('--allow-partial');
const onlyExams = (getFlag('--exams') || '').split(',').map(s => s.trim()).filter(Boolean);
const pages = Number(getFlag('--pages') || 3);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SUB_ORDER = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理'];

(async () => {
  const api = new Api(loadCreds());

  // ---- 1. 考试列表 ----
  let exams = [];
  if (onlyExams.length) {
    exams = onlyExams.map(id => ({ id: Number(id), name: '' }));
  } else {
    for (let p = 1; p <= pages; p++) {
      const r = await api.get('/v2/exam/', { role: 'grade', name: '', page: p });
      if (r.status !== 200) { console.error('考试列表 page=' + p + ' HTTP ' + r.status + ' ' + r.text.slice(0, 120)); break; }
      const j = JSON.parse(r.text);
      const rows = j.results || j.data || [];
      exams = exams.concat(rows.map(x => ({ id: x.id, name: x.name, gradeName: x.gradeName })));
      if (!rows.length || (j.count && exams.length >= j.count)) break;
      await sleep(300);
    }
  }
  exams = exams.filter(e => e.id);
  console.log('考试数:', exams.length, exams.map(e => e.id).join(','));

  const out = [];
  let missing = [];
  for (const ex of exams) {
    // ---- 2. 该场考试的各学科 ----
    let subs = null;
    for (let t = 0; t < 3 && !subs; t++) {
      try {
        const r = await api.get(`/v2/exam/${ex.id}/subjects/`);
        if (r.status === 200) subs = JSON.parse(r.text);
        else console.error(`  [${ex.id}] subjects HTTP ${r.status}`);
      } catch (e) { console.error(`  [${ex.id}] subjects ${e.message.slice(0, 80)}`); }
      if (!subs) await sleep(1000);
    }
    if (!subs) { missing.push({ exam: String(ex.id), err: 'subjects-unreadable' }); continue; }
    const list = Array.isArray(subs) ? subs : (subs.data || subs.results || []);
    list.sort((a, b) => SUB_ORDER.indexOf(a.subject.name) - SUB_ORDER.indexOf(b.subject.name));

    const line = [];
    for (const s of list) {
      const rec = {
        exam: String(ex.id), examName: ex.name || '', grade: ex.gradeName || '',
        sub: s.subject && s.subject.name, subjectId: s.subject && s.subject.id,
        examSubjectId: s.id,
        paper: (s.paper && s.paper.id) || null, paperName: (s.paper && s.paper.name) || '', paperScore: (s.paper && s.paper.score) || null,
        publishedAt: s.publishedAt || null, endAt: s.endAt || null,
        status: s.status,
        classrooms: s.classroomNames || [], classroomCount: (s.classroomNames || []).length,
        studentCount: s.studentCount, markPercent: s.markPercent,
        teacherCount: (s.teachers || []).length,
        markByTask: null, markType: null,
      };
      // ---- 3. 逐格取「阅卷分配模式」 ----
      if (rec.examSubjectId) {
        for (let t = 0; t < 3; t++) {
          try {
            const r = await api.get(`/v2/exam/subject/${rec.examSubjectId}/marker/`);
            if (r.status === 200) {
              const j = JSON.parse(r.text);
              rec.markByTask = j.markByTask; rec.markType = j.markType;
              break;
            }
            rec.err = 'marker HTTP ' + r.status;
          } catch (e) { rec.err = 'marker ' + e.message.slice(0, 80); }
          await sleep(1000);
        }
        if (rec.markByTask === null && rec.markByTask === undefined) missing.push({ exam: rec.exam, sub: rec.sub, err: rec.err || 'marker-unreadable' });
      }
      out.push(rec);
      line.push(`${rec.sub}=${rec.status}/${rec.markByTask === true ? '任务' : rec.markByTask === false ? '考试' : '?'}`);
      await sleep(120);
    }
    console.log(`  ${ex.id} (${list.length}科): ${line.join(' ')}`);
  }

  fs.writeFileSync(outPath, out.map(o => JSON.stringify(o)).join('\n') + '\n');
  const summary = {
    scannedAt: new Date().toISOString(),
    exams: exams.length, cells: out.length,
    unbound: out.filter(o => !o.paper).length,
    unpublished: out.filter(o => o.paper && !o.publishedAt).length,
    taskMarking: out.filter(o => o.markByTask === true).length,
    examMarking: out.filter(o => o.markByTask === false && o.paper).length,
    missing: missing,
    complete: missing.length === 0,
  };
  fs.writeFileSync(outPath + '.summary.json', JSON.stringify(summary, null, 1));
  console.log('\n格数', out.length, '| 未绑定', summary.unbound, '| 已绑未发布', summary.unpublished,
    '| 任务阅卷', summary.taskMarking, '| 考试阅卷', summary.examMarking);
  console.log('完整性:', summary.complete ? 'OK' : `不完整 (${missing.length} 处缺失，见 ${outPath}.summary.json)`);
  if (!summary.complete && !allowPartial) {
    console.error('拒绝当作完整结果使用：加 --allow-partial 才能继续。');
    process.exit(5);
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
