#!/usr/bin/env node
// 扫描一个「考试汇总」课程的：章节名 -> 试卷编号
//
// 用法: node scan_course.js <courseId> <outJsonl>
//   env: FUULEA_BASE            站点地址（默认 test）
//        AGENT_BROWSER_SESSION  浏览器会话名（由 exam_papers.sh 注入 fuulea-<别名>）
//
// 输出每行: {"chapter":"2024-2025第一学期高一第2次月考","onChapter":"...(URL回验)","paper":"81402404",
//            "total":100,"qcount":25,"hasEntry":false}
// 另产出 <outJsonl 同名>.meta.json: {"courseId":...,"chapters":N,"ok":true/false,"unreliable":[章节名...]}
//
// ⚠️ 本文件固化了两个"会让整批数据整体错位、却看起来完全正常"的坑，改动前务必读注释：
//   1) 章节页左侧目录是 nz-tree，里面有一个【没有 title 属性的装饰性节点】。
//      取节点清单 与 点第 i 个节点 必须用**同一套过滤条件**，否则索引整体差一位。
//   2) 点完章节必须用 URL 的 chapterName 参数回验真的切过去了，再读正文，
//      否则会读到上一章（表现为"每章都读到上一章的卷号"）。
//
// ⚠️ 另外两个"让整批数据整体为空/崩掉"的坑（v2 修复）：
//   3) 树查询可能返回 null（页面尚未渲染完）→ 任何 querySelectorAll 前必须判空，
//      否则整门课直接崩，后续课程也跟着报 OPEN_FAIL。
//   4) 不能靠固定 sleep 等页面渲染（冷启动/弱网会不够）→ 一律轮询到目标出现为止；
//      连"页面是不是 about:blank"都要显式确认（见 ab.js 的 openChecked）。
const fs = require('fs');
const { ab, ev, sleep, poll, openChecked } = require('./ab');

const CID = process.argv[2];
const OUT = process.argv[3];
const BASE = process.env.FUULEA_BASE || 'https://test.fuulea.com';
const META = OUT ? OUT.replace(/\.jsonl$/, '') + '.meta.json' : null;

if (!CID || !OUT) { console.error('用法: node scan_course.js <courseId> <outJsonl>'); process.exit(2); }

// 节点过滤条件：必须与 CLICK_JS 完全一致（见文件头坑 1）
const NODE_FILTER = `nd=>nd.offsetParent && nd.querySelector('[title]')`;

// 坑 3：tree 可能为 null，必须先判空再 querySelectorAll
const NAV_JS = `(()=>{
  const tree=document.querySelector('nz-tree.ant-tree') || document.querySelector('.ant-tree');
  if(!tree) return [];
  const nodes=[...tree.querySelectorAll('.ant-tree-treenode')].filter(${NODE_FILTER});
  return nodes.map(nd=>{
    const el=nd.querySelector('[title]');
    return { name: (el.getAttribute('title')||'').trim() || (el.innerText||'').trim() };
  });
})()`;

const CLICK_JS = (i) => `(()=>{
  const tree=document.querySelector('nz-tree.ant-tree') || document.querySelector('.ant-tree');
  if(!tree) return 'nt';
  const nodes=[...tree.querySelectorAll('.ant-tree-treenode')].filter(${NODE_FILTER});
  const nd=nodes[${i}];
  if(!nd) return 'nf';
  const el=nd.querySelector('.ant-tree-node-content-wrapper') || nd.querySelector('.ant-tree-title') || nd.querySelector('[title]');
  if(!el) return 'nt';
  el.click(); return 'ok';
})()`;

// 课程页是否已渲染出「章节内容」入口行
const ROW_JS = `(()=>{
  const rows=[...document.querySelectorAll('tr')].filter(r=>/章节内容/.test(r.innerText));
  if(!rows.length) return 'no-row';
  const b=[...rows[0].querySelectorAll('button')].find(x=>x.innerText.trim()==='章节内容');
  return b ? 'ready' : 'no-btn';
})()`;

const CLICK_ROW_JS = `(()=>{
  const rows=[...document.querySelectorAll('tr')].filter(r=>/章节内容/.test(r.innerText));
  if(!rows.length) return 'no-row';
  const b=[...rows[0].querySelectorAll('button')].find(x=>x.innerText.trim()==='章节内容');
  if(!b) return 'no-btn';
  b.click(); return 'ok';
})()`;

// 读当前章：URL 回验用 cur + 正文里的试卷号
const READ_JS = `(()=>{
  const t=(document.body.innerText.split('退出登录').pop()||'');
  const m=t.match(/#(\\d{6,})\\s*满分\\s*(\\d+)\\s*分\\s*(\\d+)\\s*道题/);
  const cur=decodeURIComponent((location.search.match(/chapterName=([^&]*)/)||[])[1]||'');
  return { cur, paper: m?m[1]:null, total: m?Number(m[2]):null, qcount: m?Number(m[3]):null,
           hasEntry: /催录题目|暂无试卷|去录题/.test(t) };
})()`;

// 打开课程页 -> 进入章节内容 -> 拿到章节清单；失败返回 null
function openCourse() {
  // 确认课程页真的渲染出来（about:blank / 空 body 一律判失败，openChecked 会硬重置重试）
  if (!openChecked(`${BASE}/course/${CID}`, { tries: 2, minLen: 20 })) {
    console.error('  OPEN_BLANK (页面始终未渲染出来)');
    return null;
  }
  const row = poll(() => ev(ROW_JS), 6, 2, 2);
  if (row !== 'ready') console.error('  OPEN_POLL=' + JSON.stringify(row));
  const clicked = ev(CLICK_ROW_JS);
  if (clicked !== 'ok') { console.error('OPEN_FAIL ' + JSON.stringify(clicked)); return null; }
  const nav = poll(() => {
    const n = ev(NAV_JS);
    return Array.isArray(n) && n.length ? n : null;
  }, 8, 2, 2);
  if (!nav) { console.error('NO_NAV (章节树未渲染或为空)'); return null; }
  return nav;
}

// 进入章节内容；整段最多重试 3 次（冷启动/弱网时第一次可能空白）
let nav = null;
for (let attempt = 1; attempt <= 3 && !nav; attempt++) {
  if (attempt > 1) console.error(`  (第 ${attempt} 次尝试打开课程 ${CID})`);
  nav = openCourse();
}
if (!nav) { console.error('COURSE_FAIL ' + CID); process.exit(2); }
console.error(`course ${CID}: ${nav.length} 个章节`);

// 逐章：点击 -> 轮询回验 chapterName -> 读卷号
const lines = [];
for (let i = 0; i < nav.length; i++) {
  const want = nav[i].name;
  if (i > 0) {
    const r = ev(CLICK_JS(i));
    if (r !== 'ok') {
      lines.push({ chapter: want, paper: null, note: 'click-fail:' + r });
      console.error(`  [${i + 1}/${nav.length}] ${want} -> CLICK_FAIL(${r})`);
      continue;
    }
  }
  const res = poll(() => {
    const x = ev(READ_JS);
    return x && x.cur && x.cur.trim() === want ? x : null;
  }, 8, 3, 2);
  if (!res) {
    const last = ev(READ_JS);
    lines.push({ chapter: want, paper: last && last.paper, onChapter: last && last.cur, note: 'name-mismatch' });
    console.error(`  [${i + 1}/${nav.length}] ${want} -> NAME_MISMATCH (实际停在: ${last && last.cur})`);
    continue;
  }
  const tag = res.paper ? res.paper : (res.hasEntry ? 'NO-PAPER(催录)' : 'NONE');
  lines.push({ chapter: want, ...res });
  console.error(`  [${i + 1}/${nav.length}] ${want} -> ${tag}`);
}

fs.writeFileSync(OUT, lines.map(o => JSON.stringify(o)).join('\n') + '\n');

// meta：给 plan_bindings.py 做「完整性闸门」用
const unreliable = lines.filter(o => o.note).map(o => o.chapter);
if (META) {
  fs.writeFileSync(META, JSON.stringify({
    courseId: CID,
    chapters: lines.length,
    ok: unreliable.length === 0,
    unreliable,
  }, null, 1) + '\n');
}
console.error('WROTE ' + OUT + (unreliable.length ? `  ⚠️ ${unreliable.length} 章不可靠（见 meta）` : ''));
