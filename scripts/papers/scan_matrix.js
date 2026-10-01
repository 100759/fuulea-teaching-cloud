#!/usr/bin/env node
// 只读抓取「全站考试 × 全学科」的绑卷矩阵
//
// 用法: node scan_matrix.js <outJsonl>
// 输出每行: {"exam":"29180","examName":"2024-2025第一学期高一第2次月考","grade":"2024级",
//            "sub":{"语文":"已绑 81816687","数学":"已绑 81700030", ... ,"历史":"未绑"}}
//
// 说明:
//  - 考试清单从 /exam 列表页翻页抓取（含 #ID、考试名、年级），不硬编码。
//  - 逐场打开 /exam/<id>/detail，按【学科】切块解析"考试内容：<卷号>"或"关联已有试卷"。
//  - 学科取全 9 科；没有该学科行时记为 "—"。
//  - 打开页面统一走 openChecked：确认真的渲染出来（不是 about:blank），失败自动硬重置会话。
const fs = require('fs');
const { ab, ev, sleep, openChecked } = require('./ab');

const OUT = process.argv[2];
const BASE = process.env.FUULEA_BASE || 'https://test.fuulea.com';
if (!OUT) { console.error('用法: node scan_matrix.js <outJsonl>'); process.exit(2); }

const LIST_JS = `(()=>{
  const items=[...document.querySelectorAll('.ant-list-item')].filter(e=>e.offsetParent);
  return items.map(it=>{
    const title=it.querySelector('h4.ant-list-item-meta-title') || it;
    const idEl=[...title.querySelectorAll('*')].find(x=>x.children.length===0 && /^#\\d+$/.test(x.textContent.trim()));
    const parts=[...title.querySelectorAll('span')].map(x=>x.textContent.trim()).filter(Boolean);
    const name = parts.find(x=>/^\\d{4}\\s*[-~—]/.test(x)) || parts.filter(x=>x!=='Pad提交' && !/^#\\d+$/.test(x))[0];
    const t=it.innerText;
    const grade=(t.match(/年级:\\s*([^\\n]+)/)||[])[1];
    return { id: idEl?idEl.textContent.trim().slice(1):null, name, grade: grade?grade.trim():null };
  }).filter(x=>x.id);
})()`;

const PAGES_JS = `(()=>[...document.querySelectorAll('.ant-pagination-item')].map(e=>e.innerText.trim()).filter(x=>/^\\d+$/.test(x)))()`;

const DETAIL_JS = `(()=>{
  const t=document.body.innerText.split('退出登录').pop();
  const subjects=['语文','数学','英语','物理','化学','生物','历史','地理','政治'];
  const out={};
  for(const s of subjects){
    const re=new RegExp('【'+s+'】([\\\\s\\\\S]{0,320}?)(?=【|学科列表|$)');
    const m=t.match(re);
    if(!m){ out[s]='—'; continue; }
    const pid=(m[1].match(/考试内容[:：]\\s*(\\d{5,})/)||[])[1];
    out[s]= pid ? ('已绑 '+pid) : (/关联已有试卷/.test(m[1]) ? '未绑' : '?');
  }
  return { examName: (t.trim().split('\\n')[0]||'').trim(), sub: out };
})()`;

// --- 1) 翻页抓考试清单 ---
if (!openChecked(`${BASE}/exam`, { sel: '.ant-list-item', minLen: 20 })) {
  console.error('OPEN_BLANK /exam 列表页未渲染'); process.exit(2);
}
const pages = ev(PAGES_JS);
const pageNums = (Array.isArray(pages) && pages.length) ? pages.map(Number) : [1];
const maxPage = Math.max(...pageNums);

const examList = [];
const seen = new Set();
for (let p = 1; p <= maxPage; p++) {
  if (p > 1) {
    ev(`(()=>{const li=[...document.querySelectorAll('.ant-pagination-item')].find(e=>e.innerText.trim()==='${p}'); if(!li) return 'nf'; li.click(); return 'ok';})()`);
    sleep(4);
  }
  const got = ev(LIST_JS);
  (Array.isArray(got) ? got : []).forEach(x => { if (!seen.has(x.id)) { seen.add(x.id); examList.push(x); } });
}
console.error(`考试清单: ${examList.length} 场（${maxPage} 页）`);

// --- 2) 逐场解析学科绑卷状态 ---
const lines = [];
for (const e of examList) {
  if (!openChecked(`${BASE}/exam/${e.id}/detail`, { minLen: 20 })) {
    console.error(`${e.id} ${e.name} -> OPEN_BLANK，跳过`);
    lines.push({ exam: e.id, examName: e.name, listName: e.name, grade: e.grade, sub: {}, note: 'open-blank' });
    continue;
  }
  const d = ev(DETAIL_JS);
  const sub = (d && d.sub) || {};
  lines.push({ exam: e.id, examName: (d && d.examName) || e.name, listName: e.name, grade: e.grade, sub });
  const bound = Object.values(sub).filter(v => typeof v === 'string' && v.startsWith('已绑')).length;
  console.error(`${e.id} ${e.name} -> 已绑 ${bound}/9`);
}

fs.writeFileSync(OUT, lines.map(o => JSON.stringify(o)).join('\n') + '\n');
console.error('WROTE ' + OUT);
