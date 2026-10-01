// 批量下载「成绩上传模板（全通教育 班级对照表）」（只读：全是 GET）
//
// 路径：任务详情 → 导入成绩 → 数据源选「全通教育」→ 班级对照表 下载
//      底层接口 = GET /v2/tasks/<taskId>/class-list/
//
// 用法:
//   node download_exam_templates.js <gradeId> <outdir> [--all|--dedup]
//     --dedup  每个「考试 × 学科」只留一份代表文件（目录按考试分文件夹，文件名为学科）
//     --all    每个任务各留一份（默认）
//
// 依赖: scripts/api.js 的凭据（先跑 `node scripts/api.js creds`）
const fs = require('fs');
const path = require('path');
const { Api, loadCreds } = require('./api.js');
const { sleep } = require('./cdp/cdp.js');

const args = process.argv.slice(2);
const GRADE = Number(args[0]);
const OUT = args[1];
const DEDUP = args.includes('--dedup');

if (!GRADE || !OUT) { console.error('用法: node download_exam_templates.js <gradeId> <outdir> [--dedup|--all]'); process.exit(2); }

const SUBJ_ORDER = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理'];
const safe = s => String(s).replace(/[\/\\:*?"<>|\s]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { jwt, uuid } = loadCreds();
  const api = new Api({ jwt, uuid });

  // 1) 取该年级的学科 id（借任意一场考试的 subjects 接口）
  const exams = [];
  for (let p = 1; p <= 20; p++) {
    const r = await api.get('/v2/exam/', { role: 'grade', name: '', page: p });
    const rs = (r.json && r.json.results) || [];
    exams.push(...rs.filter(e => !e.gradeId || e.gradeId === GRADE));
    if (rs.length < 15) break;
  }
  const target = exams.find(e => e.gradeId === GRADE) || exams[0];
  if (!target) throw new Error('该年级没有考试，无法取学科表');
  const sj = await api.get('/v2/exam/' + target.id + '/subjects/');
  const subjects = (sj.json.data || []).map(d => ({ id: d.subject.id, name: d.subject.name }));
  console.log('学科:', subjects.map(s => s.name).join(' '));

  // 2) 枚举任务
  const tasks = [];
  for (const s of subjects) {
    let page = 1, got = [];
    while (true) {
      const r = await api.get('/v2/tasks/', { subjectId: s.id, gradeId: GRADE, type: 2, page });
      const rs = (r.json && r.json.results) || [];
      got.push(...rs);
      if (rs.length < 15 || got.length >= (r.json.count || 0)) break;
      page++; if (page > 60) break;
    }
    const m = new Map(); for (const t of got) m.set(t.taskId, t);
    console.log('  ' + s.name + ' → ' + m.size + ' 个任务');
    tasks.push(...m.values());
    await sleep(150);
  }
  console.log('任务合计:', tasks.length);

  // 3) 下载
  const idxPath = path.join(OUT, '_index.jsonl');
  const idx = fs.existsSync(idxPath) ? fs.readFileSync(idxPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const done = new Set(idx.filter(r => r.ok).map(r => String(r.taskId)));
  const rawDir = path.join(OUT, '.raw');
  fs.mkdirSync(rawDir, { recursive: true });

  let ok = 0, fail = 0;
  for (const t of tasks) {
    const id = String(t.taskId);
    const dest = path.join(rawDir, id + '.xlsx');
    if (done.has(id) && fs.existsSync(dest)) { ok++; continue; }
    const rec = { taskId: t.taskId, title: t.title, classroomName: t.classroomName, ok: false };
    try {
      const buf = await api.getBinary('/v2/tasks/' + id + '/class-list/');
      if (buf.length < 1000 || buf.slice(0, 2).toString('hex') !== '504b') throw new Error('非 xlsx (' + buf.length + 'B)');
      fs.writeFileSync(dest, buf);
      rec.ok = true; rec.bytes = buf.length; ok++;
    } catch (e) { fail++; rec.err = e.message; console.log('[FAIL] ' + id + ' ' + t.title + ' :: ' + e.message); }
    idx.push(rec);
    fs.writeFileSync(idxPath, idx.map(r => JSON.stringify(r)).join('\n') + '\n');
    await sleep(120);
  }
  console.log('下载完成 ok=' + ok + ' fail=' + fail);

  // 4) 汇总
  const groups = new Map();
  for (const r of idx.filter(r => r.ok)) {
    const parts = String(r.title || '').split(' ');
    const subj = parts[parts.length - 1], exam = parts.slice(0, -1).join(' ');
    const k = exam + '||' + subj;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const manifest = [];
  for (const [k, rs] of groups) {
    const [exam, subj] = k.split('||');
    const rep = rs.reduce((a, b) => (b.bytes > a.bytes ? b : a));
    const src = path.join(rawDir, String(rep.taskId) + '.xlsx');
    const d = DEDUP ? path.join(OUT, exam) : rawDir;
    fs.mkdirSync(d, { recursive: true });
    const outFile = DEDUP ? path.join(d, subj + '.xlsx') : path.join(d, safe(exam) + '_' + subj + '.xlsx');
    fs.copyFileSync(src, outFile);
    manifest.push({ exam, subject: subj, file: path.relative(OUT, outFile), bytes: fs.statSync(outFile).size, taskCount: rs.length });
  }
  manifest.sort((a, b) => a.exam.localeCompare(b.exam) || SUBJ_ORDER.indexOf(a.subject) - SUBJ_ORDER.indexOf(b.subject));
  fs.writeFileSync(path.join(OUT, '_manifest.json'), JSON.stringify(manifest, null, 1));
  console.log('交付文件数:', manifest.length, '→', OUT);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
