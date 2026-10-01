#!/usr/bin/env node
// 只读核对：逐条打开「关联已有试卷」弹层，输入试卷编号，读出候选项的**真实卷名**
//
// 用法: node verify_bindings.js <proposals.json> <outJsonl>
//
// 为什么要这一步：
//   弹层的选择框按**名称**搜是"全库模糊搜"，会返回别的学校的同名卷子；
//   按**编号**搜则唯一。此脚本用编号搜并回读卷名，等于让系统自己确认
//   "这个编号 = 这张卷"，是绑定前最后一道人工可核对的关口。
//   ⚠️ 本脚本全程只读，末尾会点「取消」关掉弹层，不会提交。
const fs = require('fs');
const { ab, ev, sleep, poll, openChecked } = require('./ab');

const IN = process.argv[2];
const OUT = process.argv[3];
const BASE = process.env.FUULEA_BASE || 'https://test.fuulea.com';
if (!IN || !OUT) { console.error('用法: node verify_bindings.js <proposals.json> <outJsonl>'); process.exit(2); }

const OPEN_JS = (subject) => `(()=>{
  const lbl=[...document.querySelectorAll('*')].find(e=>e.children.length===0 && e.textContent.trim()==='【${subject}】' && e.offsetParent);
  if(!lbl) return 'no-label';
  let row=lbl;
  for(let i=0;i<6&&row;i++){ if(row.querySelector&&row.querySelector('button')&&row.innerText.includes('关联已有试卷')) break; row=row.parentElement; }
  if(!row) return 'no-row';
  const b=[...row.querySelectorAll('button')].find(x=>x.innerText.trim()==='关联已有试卷');
  if(!b) return 'no-btn';
  b.click(); return 'ok';
})()`;

const OPTIONS_JS = `(()=>[...document.querySelectorAll('.ant-select-item-option')].map(e=>e.innerText.trim()))()`;

const proposals = JSON.parse(fs.readFileSync(IN, 'utf8'));
const lines = [];
let multi = 0;

for (const p of proposals) {
  const { examId, subject, paper, examName } = p;

  // 确认详情页真的渲染出来（about:blank / 空 body 会硬重置会话重试）
  if (!openChecked(`${BASE}/exam/${examId}/detail`, { minLen: 20 })) {
    lines.push({ ...p, options: [], note: 'open-blank' });
    console.error(`${examId} ${subject} -> OPEN_BLANK`);
    continue;
  }

  const r = ev(OPEN_JS(subject));
  if (r !== 'ok') {
    lines.push({ ...p, options: [], note: 'open-fail:' + r });
    console.error(`${examId} ${subject} -> OPEN_FAIL(${r})`);
    continue;
  }
  sleep(3);

  try { ab(['type', '.ant-modal input.ant-select-selection-search-input', String(paper)]); } catch (e) {}
  sleep(1);
  try { ab(['press', 'Enter']); } catch (e) {}   // ⚠️ 必须按 Enter 才会触发搜索
  // 轮询等候选项出现，别赌固定等待
  poll(() => {
    const o = ev(OPTIONS_JS);
    return Array.isArray(o) && o.length ? o : null;
  }, 4, 2, 2);

  const opts = ev(OPTIONS_JS);
  const list = Array.isArray(opts) ? opts : [];
  if (list.length !== 1) multi++;
  lines.push({ examId, subject, paper, examName, options: list });

  const hit = list.find(x => String(x).includes(String(paper))) || list[0] || '(无候选项)';
  console.error(`${examId} ${subject} ${paper} -> [${list.length}项] ${hit}`);

  ev(`(()=>{const m=document.querySelector('.ant-modal'); if(!m) return 'no-modal'; const b=[...m.querySelectorAll('button')].find(x=>x.innerText.trim()==='取消'); if(b){b.click();return 'ok';} return 'no-cancel';})()`);
  sleep(2);
}

fs.writeFileSync(OUT, lines.map(o => JSON.stringify(o)).join('\n') + '\n');
console.error(`WROTE ${OUT}（候选项不唯一的: ${multi} 条）`);
if (multi) console.error('⚠️ 有候选项不唯一的条目，绑定时务必用关键词护栏核对卷名，或人工确认后再绑。');
