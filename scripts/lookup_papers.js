// 只读：在试卷库中检索「考试范围」试卷（用于判定某场考试的卷到底存不存在）
//
// 参数结构来源：前端 chunk-JQSFN3X7.js 的 fl-set-template 组件（考试详情页「关联已有试卷」弹窗）
//   onPaperSearch(e){ this.searchPaperChange$.next({kw:e, subjectId:this.examSubject.subject.id, scope:"exam"}) }
//   → itSrv.getPaperLists(o) → doGet("/papers/", o)
// 即：GET /v2/papers/?kw=<关键词>&subjectId=<学科id>&scope=exam&page=<n>&pageSize=<n>
//   kw      —— 模糊匹配卷名（支持空格分词；跨校，全平台可见）
//   scope   —— "exam"(考试卷) / "all" / "course" / "task" / "exercise" / "blackboard" / "tk" / "special"
//   subjectId —— 学科 id（语文7 数学1 英语6 物理3 化学2 生物5 历史8 地理9 政治10）
// 注意：不带 scope/subjectId 时会命中全库（count 数十万），务必带上。
//
// 用法：
//   node lookup_papers.js <subjectId> <kw> [--pages N] [--json]
//   node lookup_papers.js 5 "2025-2026第二学期高二第2次月考"
//   node lookup_papers.js 5 "第2次月考" --pages 5
//
// 退出码：0 = 找到至少 1 条精确同名；3 = 没找到精确同名（但可能有模糊命中）；1 = 出错

const { Api, loadCreds } = require(__dirname + '/api.js');

const SUBJ_NAME = { 7: '语文', 1: '数学', 6: '英语', 3: '物理', 2: '化学', 5: '生物', 8: '历史', 9: '地理', 10: '政治' };

async function main() {
  const args = process.argv.slice(2);
  const subjId = parseInt(args[0], 10);
  const kw = args[1];
  const jsonOut = args.includes('--json');
  const pi = args.indexOf('--pages');
  const maxPages = pi >= 0 ? parseInt(args[pi + 1], 10) : 3;

  if (!subjId || !kw) {
    console.log('用法: node lookup_papers.js <subjectId> <kw> [--pages N] [--json]');
    console.log('示例: node lookup_papers.js 5 "2025-2026第二学期高二第2次月考"');
    process.exit(1);
  }

  const api = new Api(loadCreds());
  const all = [];
  let count = null;
  for (let page = 1; page <= maxPages; page++) {
    const r = await api.get('/v2/papers/', { kw, subjectId: subjId, scope: 'exam', page, pageSize: 50 });
    if (r.status !== 200) {
      console.error(`HTTP ${r.status} (page ${page}): ${r.text.slice(0, 200)}`);
      process.exit(1);
    }
    const j = r.json || {};
    count = j.count;
    const res = j.results || [];
    all.push(...res);
    if (res.length < 50) break;
  }

  const exact = all.filter(p => (p.name || '').trim() === kw.trim());
  if (jsonOut) {
    console.log(JSON.stringify({ subjectId: subjId, kw, count, fetched: all.length, exact, results: all }, null, 1));
  } else {
    console.log(`学科=${SUBJ_NAME[subjId] || subjId}  关键词="${kw}"  库内命中 count=${count}  取回 ${all.length} 条`);
    for (const p of all) {
      const mark = (p.name || '').trim() === kw.trim() ? '  ★精确同名' : '';
      console.log(`  #${p.id}  ${p.name}${mark}`);
    }
    if (!all.length) console.log('  （无命中）');
    console.log(exact.length ? `\n⇒ 精确同名命中 ${exact.length} 条：${exact.map(p => '#' + p.id).join(', ')}`
      : `\n⇒ 全库无精确同名卷 —— 该卷尚未创建/录入`);
  }
  process.exit(exact.length ? 0 : 3);
}

main().catch(e => { console.error('异常: ' + e.message); process.exit(1); });
