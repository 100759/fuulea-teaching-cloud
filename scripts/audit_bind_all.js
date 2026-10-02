#!/usr/bin/env node
/**
 * audit_bind_all.js —— 全站绑卷一致性核查（只读）
 *
 * 逐格比对「考试名的学期/年级」与「所绑试卷名」的学期/年级标识，
 * 把学期/年级明显矛盾的格标为 ★可疑。
 *
 * 用法：
 *   node audit_bind_all.js [out.json]
 *   默认输出 /tmp/fuulea/bind_audit_<date>.json
 *
 * 背景：绑错卷（例如「第一学期」的考试绑到了「第二学期」的卷）会让该科的
 * 「小题分」模板题号列数 = 错卷的题数，与源成绩表的题数对不上 →
 * 那份文件根本填不出来/没产出。详见 references/bind-papers-workflow.md §10。
 *
 * ⚠️ 只读。发现可疑格后【先判责、先问用户】，不要自行重绑（§10.4）。
 */
const path = require('path');
const fs = require('fs');
const apiMod = require(path.join(__dirname, 'api.js'));
const api = new apiMod.Api(apiMod.loadCreds());

function keyOfExam(name) {
  const sem = /第一学期/.test(name) ? '上' : (/第二学期/.test(name) ? '下' : null);
  const grade = /高一/.test(name) ? '高一' : (/高二/.test(name) ? '高二' : (/高三/.test(name) ? '高三' : null));
  const kind = /第1次月考/.test(name) ? '月考1' : /第2次月考/.test(name) ? '月考2'
    : /期中/.test(name) ? '期中' : /期末/.test(name) ? '期末' : /开学联考/.test(name) ? '开学联考' : null;
  return { sem, grade, kind };
}

function flagsOfPaper(pname) {
  if (!pname) return { sem: null, grade: null, kind: null, none: true };
  let sem = null;
  if (/第二学期|下·|下\.|-下|下_/.test(pname)) sem = '下';
  if (/第一学期|上·|上\.|-上|上_/.test(pname)) sem = sem === '下' ? '冲突' : '上';
  return {
    none: false,
    sem,
    grade: /高一/.test(pname) ? '高一' : /高二/.test(pname) ? '高二' : /高三/.test(pname) ? '高三' : null,
    kind: /第1次月考|月考1|第一次月考/.test(pname) ? '月考1'
      : /第2次月考|月考2|第二次月考/.test(pname) ? '月考2'
      : /期中/.test(pname) ? '期中' : /期末/.test(pname) ? '期末' : null,
  };
}

/** 注意：接口在没有绑卷时返回的是 paper:{id:null,name:null} —— 非 null 对象。
 *  所以必须判 p.id / p.name 是否为空，不能只判 p 的真假。 */
function hasPaper(p) { return !!(p && p.id); }

(async () => {
  const exams = [];
  for (let p = 1; p <= 5; p++) {
    const ex = await api.get('/v2/exam/', { role: 'grade', name: '', page: p });
    const arr = (ex.json && (ex.json.results || ex.json.data)) || [];
    if (!arr.length) break;
    exams.push(...arr);
  }
  exams.sort((a, b) => a.id - b.id);
  console.log('考试数', exams.length);

  const rows = [];
  for (const e of exams) {
    const s = await api.get('/v2/exam/' + e.id + '/subjects/');
    const arr = (s.json && (s.json.data || s.json.results)) || [];
    const k = keyOfExam(e.name);
    for (const it of arr) {
      const sub = (it.subject && it.subject.name) || '?';
      const p = it.paper || null;
      const f = flagsOfPaper(p && p.name);
      let verdict;
      if (!hasPaper(p)) verdict = '缺卷';
      else if (f.sem === '冲突') verdict = '★卷名学期自相矛盾';
      else if (f.sem && k.sem && f.sem !== k.sem) verdict = '★学期不符';
      else if (f.grade && k.grade && f.grade !== k.grade) verdict = '★年级不符';
      else if (!f.sem && !f.grade && !f.kind) verdict = '卷名无标识(人工核)';
      else verdict = 'ok';
      rows.push({
        exam: e.id, examName: e.name, sub, esId: it.id,
        paper: p && p.id, paperName: p && p.name, status: it.status, verdict,
      });
    }
  }

  const bad = rows.filter(r => r.verdict.startsWith('★'));
  const manual = rows.filter(r => r.verdict === '卷名无标识(人工核)');
  const none = rows.filter(r => r.verdict === '缺卷');

  console.log('总格数', rows.length, ' 可疑', bad.length, ' 缺卷', none.length, ' 需人工', manual.length);
  console.log('\n=== ★ 可疑 ===');
  bad.forEach(r => console.log(`  ${r.exam} ${r.examName} | ${r.sub} | ${r.paper} 《${r.paperName}》 | ${r.verdict}`));
  console.log('\n=== 缺卷 ===');
  none.forEach(r => console.log(`  ${r.exam} ${r.examName} | ${r.sub} | esId=${r.esId} status=${r.status}`));
  console.log('\n=== 卷名无标识（需人工看） ===');
  manual.forEach(r => console.log(`  ${r.exam} ${r.examName} | ${r.sub} | ${r.paper} 《${r.paperName}》`));

  const out = process.argv[2] || `/tmp/fuulea/bind_audit_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(rows, null, 1));
  console.log('\n已写 ' + out);
  process.exit(bad.length ? 5 : 0);
})();
