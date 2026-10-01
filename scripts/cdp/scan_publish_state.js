// 只读扫描：全站 考试 × 学科 的「绑卷 + 发布」状态（增量写盘 + 自愈）
// 用法: node scan_publish_state.js <outJsonl> [examId,...]
//
// ⚠️ 「已发布」判定必须用班级列表 /20\d\d级\d+班/，**不能**用是否出现「时间:」——
//    考试级时间也会出现在尚未发布的学科行上，用「时间:」会把待发布行误判为已发布。
const fs = require('fs');
const { sleep } = require(__dirname + '/cdp.js');
const { Session, BASE } = require(__dirname + '/session.js');
const OUT = process.argv[2];
const ONLY = process.argv[3] ? process.argv[3].split(',') : null;

const LIST_JS = `(()=>{
  const items=[...document.querySelectorAll('.ant-list-item')].filter(e=>e.offsetParent);
  const list=items.map(it=>{
    const title=it.querySelector('h4.ant-list-item-meta-title')||it;
    const idEl=[...title.querySelectorAll('*')].find(x=>x.children.length===0&&/^#\\d+$/.test(x.textContent.trim()));
    const parts=[...title.querySelectorAll('span')].map(x=>x.textContent.trim()).filter(Boolean);
    const name=parts.find(x=>/^\\d{4}\\s*[-~—]/.test(x))||parts.filter(x=>x!=='Pad提交'&&!/^#\\d+$/.test(x))[0];
    const t=it.innerText;
    const grade=(t.match(/年级:\\s*([^\\n]+)/)||[])[1];
    return { id:idEl?idEl.textContent.trim().slice(1):null, name, grade:grade?grade.trim():null };
  }).filter(x=>x.id);
  return { n:list.length, list };
})()`;

const ROWS_JS = `(()=>{
  const labels=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&/^【.+】$/.test(e.textContent.trim())&&e.offsetParent);
  const out=[];
  for(const lb of labels){
    let row=lb;
    for(let i=0;i<8&&row;i++){ if(row.querySelector&&row.innerText&&row.innerText.includes('阅卷分配')) break; row=row.parentElement; }
    if(!row) continue;
    const sub=lb.textContent.trim().replace(/[【】]/g,'');
    const txt=row.innerText.replace(/\\s+/g,' ').trim();
    const m=txt.match(/考试内容[:：](\\d+)/);
    const timeM=txt.match(/时间:\\s*(\\d{2}-\\d{2} \\d{2}:\\d{2} - \\d{2}-\\d{2} \\d{2}:\\d{2})/);
    // 行内 ≥3 个班时只列前 2 个 +「等N个班级」，真实班级数要以此为准
    const clsShown=txt.match(/20\\d\\d级\\d+班/g)||[];
    const etcM=txt.match(/等(\\d+)个班级/);
    const classCount=etcM?Number(etcM[1]):clsShown.length;
    const dis=(t)=>{const b=[...row.querySelectorAll('button')].find(x=>x.innerText.trim()===t); if(!b) return null;
      const c=getComputedStyle(b).color; return !!(b.disabled||b.classList.contains('disabled')||c==='rgba(0, 0, 0, 0.25)');};
    const markBtn=[...row.querySelectorAll('button')].find(x=>/^(重新|开始|结束)?阅卷$/.test(x.innerText.trim())&&x.innerText.trim()!=='阅卷分配');
    out.push({ sub, paper:m?m[1]:null,
      published:/20\\d\\d级\\d+班/.test(txt),   // ← 只看班级列表，勿改回「时间:」
      time:timeM?timeM[1]:null,
      classes:clsShown, classCount:classCount,
      pubDisabled:dis('发布'), assignDisabled:dis('阅卷分配'),
      mark:markBtn?markBtn.innerText.trim():null, raw:txt.slice(0,240) });
  }
  return { n:out.length, rows:out };
})()`;

const NAME_JS = `(()=>{const t=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&/^\\d{4}[-~—]\\d{4}/.test(e.textContent.trim())&&e.offsetParent);return t?t.textContent.trim():null})()`;

(async () => {
  const s = new Session();
  let examList = [];
  if (ONLY) examList = ONLY.map(id => ({ id, name: null, grade: null }));
  else {
    await s.goto(`${BASE}/exam`, { settle: 4500 });
    const first = await s.val(LIST_JS);
    if (!first || !first.n) throw new Error('考试列表为空');
    const seen = new Set();
    const push = l => l.forEach(x => { if (!seen.has(x.id)) { seen.add(x.id); examList.push(x); } });
    push(first.list);
    for (let p = 2; p <= 4; p++) {
      const clicked = await s.val(`(()=>{const li=[...document.querySelectorAll('.ant-pagination-item')].find(e=>e.innerText.trim()==='${p}'); if(!li) return false; li.click(); return true;})()`);
      if (!clicked) break;
      await sleep(4500);
      const g = await s.val(LIST_JS);
      if (!g || !g.n) break;
      const before = examList.length; push(g.list);
      if (examList.length === before) break;
    }
  }
  console.error(`考试清单: ${examList.length} 场`);
  fs.writeFileSync(OUT, '');

  for (const e of examList) {
    let rec = { exam: e.id, examName: e.name, listName: e.name, grade: e.grade, sub: {}, error: null };
    try {
      await s.goto(`${BASE}/exam/${e.id}/detail`, { settle: 5000 });
      const r = (await s.val(ROWS_JS)) || { n: 0, rows: [] };
      const nm = await s.val(NAME_JS);
      rec.examName = nm || e.name;
      r.rows.forEach(x => rec.sub[x.sub] = x);
      if (!r.n) rec.error = '页面未读到学科行';
    } catch (err) { rec.error = err.message.slice(0, 200); }
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
    const rows = Object.values(rec.sub);
    const pub = rows.filter(x => x.published).length;
    const ready = rows.filter(x => x.paper && !x.published && x.pubDisabled === false).length;
    console.error(`${e.id} ${rec.examName} -> 已发布 ${pub} / 待发布 ${ready} / 有卷 ${rows.filter(x => x.paper).length}${rec.error ? '  [' + rec.error + ']' : ''}`);
  }
  console.error('WROTE ' + OUT);
  await s.reset();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
