// 智慧教学云 · 批量发布考试学科任务（生产站写操作，四道护栏）
//
// 用法:
//   node publish_exam_task.js <items.jsonl> <out.jsonl> [--config cfg.json] [--limit N] [--start N] [--dry]
//
// items.jsonl 每行: {"exam":"29194","examName":"…","sub":"地理","paper":"81813364"}
// cfg.json（可选，缺省见 DEFAULT_CFG）:
//   { "publishedAt":"2026-09-28 17:00", "endAt":"2026-09-28 18:00",
//     "classes":["2024级9班","2024级10班","2024级18班","2024级19班"],
//     "shotsDir":"/tmp/fuulea/publish-shots" }
//
// 护栏:
//   1 卷号核对   打开抽屉前，行内「考试内容：<编号>」必须等于清单编号，否则中止
//   2 幂等       该行已有班级列表 → 跳过
//   3 时间校验   两个日期控件的值必须精确等于配置值，否则**不提交**并关抽屉
//   4 班级校验   「已选 N 个班级」必须 = classes.length，且逐班命中、无多选，否则**不提交**
//   5 发布后复核 重新加载列表页，确认该行已带班级与时间
//
// ⚠️ 复核**不校验班级数**：服务端会把班级收窄到该学科实际有效的班
//    （实测地理恒 2 个班、化学恒 3 个班，与其它场次/其它发布人的结果一致）。
//    抽屉里勾的班级数只用于提交前护栏，不能拿来断言发布结果。
const fs = require('fs');
const { sleep } = require(__dirname + '/cdp.js');
const { Session, BASE } = require(__dirname + '/session.js');

const DEFAULT_CFG = {
  publishedAt: '2026-09-28 17:00',
  endAt: '2026-09-28 18:00',
  classes: ['2024级9班', '2024级10班', '2024级18班', '2024级19班'],
  shotsDir: '/tmp/fuulea/publish-shots',
};

const args = process.argv.slice(2);
const cfgIdx = args.indexOf('--config');
const CFG = Object.assign({}, DEFAULT_CFG, cfgIdx >= 0 ? JSON.parse(fs.readFileSync(args[cfgIdx + 1], 'utf8')) : {});
const OUT = args[1];
const ITEMS = args[0];
const DRY = args.includes('--dry');
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const START = args.includes('--start') ? Number(args[args.indexOf('--start') + 1]) : 0;

// "2026-09-28 17:00" → {yy, mm, dd, hh, mi, day:'09-28', val:'09-28 17:00'}
function parseDT(s) {
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) throw new Error('config 时间格式应为 YYYY-MM-DD HH:mm，收到: ' + s);
  const [, yy, mm, dd, hh, mi] = m;
  return { yy: +yy, mm: +mm, dd: +dd, hh, mi, day: `${mm}-${dd}`, val: `${mm}-${dd} ${hh}:${mi}` };
}
const PUB = parseDT(CFG.publishedAt), END = parseDT(CFG.endAt);
const CLASSES = CFG.classes;
const SHOTS = CFG.shotsDir;
fs.mkdirSync(SHOTS, { recursive: true });

const OV = `(document.querySelector('.cdk-overlay-container')||document.body)`;
const DD = `[...document.querySelectorAll('.ant-picker-dropdown')].filter(e=>e.offsetParent).pop()`;

const JS = {
  rowState: sub => `(()=>{
    const lb=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='【${sub}】'&&e.offsetParent);
    if(!lb) return {err:'no-label'};
    let row=lb; for(let i=0;i<8&&row;i++){ if(row.querySelector&&row.innerText&&row.innerText.includes('阅卷分配')) break; row=row.parentElement; }
    if(!row) return {err:'no-row'};
    const txt=row.innerText.replace(/\\s+/g,' ').trim();
    const m=txt.match(/考试内容[:：](\\d+)/);
    const b=[...row.querySelectorAll('button')].find(x=>x.innerText.trim()==='发布');
    // 行内 ≥3 个班时只列前 2 个 +「等N个班级」，真实班级数以此为准
    const clsShown=txt.match(/20\\d\\d级\\d+班/g)||[];
    const etcM=txt.match(/等(\\d+)个班级/);
    return { paper:m?m[1]:null, text:txt.slice(0,220),
      published:/20\\d\\d级\\d+班/.test(txt),
      time:(txt.match(/时间:\\s*(\\d{2}-\\d{2} \\d{2}:\\d{2} - \\d{2}-\\d{2} \\d{2}:\\d{2})/)||[])[1]||null,
      classes:clsShown, classCount:etcM?Number(etcM[1]):clsShown.length,
      hasPubBtn:!!b, pubDisabled: b?!!(b.disabled||getComputedStyle(b).color==='rgba(0, 0, 0, 0.25)'):null };
  })()`,
  clickPub: sub => `(()=>{
    const lb=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='【${sub}】'&&e.offsetParent);
    if(!lb) return 'no-label';
    let row=lb; for(let i=0;i<8&&row;i++){ if(row.querySelector&&row.innerText&&row.innerText.includes('阅卷分配')) break; row=row.parentElement; }
    const b=[...row.querySelectorAll('button')].find(x=>x.innerText.trim()==='发布');
    if(!b) return 'no-btn'; b.click(); return 'ok';
  })()`,
  drawerOpen: `(()=>{const ov=${OV};const t=ov.innerText;return /发布设置/.test(t)&&/任务名称/.test(t)})()`,
  openPicker: i => `(()=>{const ov=${OV};const ps=[...ov.querySelectorAll('.ant-picker')].filter(e=>e.offsetParent);const p=ps[${i}];if(!p)return 'no-picker';const inp=p.querySelector('input');inp.focus();inp.click();return 'ok'})()`,
  // 面板可能停在别的月份 → 先翻到目标年月
  seekMonth: (yy, mm) => `(()=>{
    const cur=()=>{const d=(${DD});if(!d)return null;const t=(d.querySelector('.ant-picker-header-view')||{}).innerText||'';const m=t.match(/(\\d{4})年\\s*(\\d{1,2})月/);return m?{y:+m[1],m:+m[2],d}:null;};
    const target=${yy}*12+${mm};
    for(let i=0;i<36;i++){
      const c=cur(); if(!c) return 'no-panel';
      const n=c.y*12+c.m;
      if(n===target) return 'ok';
      const b=c.d.querySelector(n<target?'.ant-picker-header-next-btn':'.ant-picker-header-prev-btn');
      if(!b) return 'no-btn'; b.click();
    }
    return 'give-up';
  })()`,
  clickDay: day => `(()=>{const d=(${DD});if(!d)return 'no-panel';const td=[...d.querySelectorAll('td.ant-picker-cell')].find(x=>(x.getAttribute('title')||'').startsWith('${day}'));if(!td)return 'no-cell';(td.querySelector('.ant-picker-cell-inner')||td).click();return 'ok'})()`,
  // 时间列的 li 上没有 data-value，只能按文本匹配
  clickTime: (col, val) => `(()=>{const d=(${DD});if(!d)return 'no-panel';const c=[...d.querySelectorAll('.ant-picker-time-panel-column')][${col}];if(!c)return 'no-col';const li=[...c.querySelectorAll('li')].find(x=>x.textContent.trim()==='${val}');if(!li)return 'no-li';try{li.scrollIntoView({block:'center'})}catch(e){};li.click();return 'ok'})()`,
  clickOk: `(()=>{const d=(${DD});if(!d)return 'no-panel';const b=d.querySelector('.ant-picker-ok button');if(!b)return 'no-ok';b.click();return 'ok'})()`,
  pickerVals: `(()=>[...${OV}.querySelectorAll('.ant-picker')].filter(e=>e.offsetParent).map(x=>x.querySelector('input').value))()`,
  next: `(()=>{const ov=${OV};const b=[...ov.querySelectorAll('button')].find(x=>x.innerText.trim()==='下一步');if(!b)return 'nf';b.click();return 'ok'})()`,
  step2: `(()=>{const ov=${OV};return /已选/.test(ov.innerText)&&/选择班级/.test(ov.innerText)})()`,
  // 「管理的班级」默认未勾选 → 页面显示"没有可用班级"，必须先勾上
  checkManaged: `(()=>{const ov=${OV};const cb=[...ov.querySelectorAll('.ant-checkbox-wrapper')].find(e=>e.innerText.includes('管理的班级'));if(!cb)return 'nf';const inp=cb.querySelector('input[type=checkbox]');if(!(inp&&inp.checked)){(cb.querySelector('.ant-checkbox')||cb).click();}return 'ok'})()`,
  // 班级不是原生 checkbox，选中标记是 .chose-class_checkbox 上的 class `select`
  selectClasses: `(()=>{const ov=${OV};const want=${JSON.stringify(CLASSES)};const res=[];for(const n of want){
    const el=[...ov.querySelectorAll('*')].filter(e=>e.children.length===0&&e.textContent.trim()===n&&e.offsetParent).pop();
    if(!el){res.push(n+':nf');continue;}
    const box=el.closest('.chose-class_checkbox')||el.parentElement;
    if(box&&box.classList.contains('select')){res.push(n+':already');continue;}
    el.click();res.push(n+':ok');}
    return res;})()`,
  classState: `(()=>{const ov=${OV};const m={};
    for(const e of [...ov.querySelectorAll('*')].filter(x=>x.children.length===0&&/^20\\d\\d级\\d+班$/.test(x.textContent.trim())&&x.offsetParent)){
      const box=e.closest('.chose-class_checkbox');
      m[e.textContent.trim()]=box?box.classList.contains('select'):null;
    }
    return m;})()`,
  counter: `(()=>{const ov=${OV};const m=ov.innerText.match(/已选[:：]?\\s*(\\d+)\\s*个班级/);return m?Number(m[1]):null})()`,
  submit: `(()=>{const ov=${OV};const b=[...ov.querySelectorAll('button')].find(x=>x.innerText.trim()==='发布任务');if(!b)return 'nf';b.click();return 'ok'})()`,
  // 步骤条上一直写着"3 发布成功"，只能用这句判断真的成功
  success: `(()=>{const ov=${OV};return /可在任务查看当前发布的作业/.test(ov.innerText)})()`,
  successInfo: `(()=>{const ov=${OV};const t=ov.innerText.replace(/\\n{2,}/g,'\\n').trim();const i=t.indexOf('发布成功');return i>=0?t.slice(i,i+300):t.slice(0,300)})()`,
  // ⚠️ 截图前必须把目标学科行滚进视口：学科行很长，靠后的学科（政治/历史/地理）
  //    在折叠线以下，直接截图只拍到页面顶部 → 留证失真（2026-09-30 实测）
  scrollRow: sub => `(()=>{
    const lb=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='【${sub}】'&&e.offsetParent);
    if(!lb) return 'no-label'; lb.scrollIntoView({block:'center'}); return 'ok';
  })()`,
  dismiss: `(()=>{const ov=${OV};const b=[...ov.querySelectorAll('button')].find(x=>x.innerText.trim()==='确定');if(!b)return 'nf';b.click();return 'ok'})()`,
  cancel: `(()=>{const ov=${OV};const b=[...ov.querySelectorAll('button')].find(x=>x.innerText.trim()==='取消发布');if(!b)return 'nf';b.click();return 'ok'})()`,
};

async function setPicker(s, idx, dt, label) {
  const r0 = await s.val(JS.openPicker(idx));
  if (r0 !== 'ok') throw new Error(`${label}: 打不开日期控件 ${r0}`);
  await sleep(1600);
  const r1 = await s.val(JS.seekMonth(dt.yy, dt.mm));
  if (r1 !== 'ok') throw new Error(`${label}: 面板翻月失败 ${r1}`);
  await sleep(500);
  const r2 = await s.val(JS.clickDay(dt.day));
  if (r2 !== 'ok') throw new Error(`${label}: 选日期失败 ${r2}`);
  await sleep(700);
  const r3 = await s.val(JS.clickTime(0, dt.hh));
  if (r3 !== 'ok') throw new Error(`${label}: 选小时失败 ${r3}`);
  await sleep(500);
  const r4 = await s.val(JS.clickTime(1, dt.mi));
  if (r4 !== 'ok') throw new Error(`${label}: 选分钟失败 ${r4}`);
  await sleep(500);
  const r5 = await s.val(JS.clickOk);
  if (r5 !== 'ok') throw new Error(`${label}: 确定失败 ${r5}`);
  await sleep(1200);
}

async function publishOne(s, it, log) {
  const tag = `${it.exam}-${it.sub}-${it.paper}`;
  await s.goto(`${BASE}/exam/${it.exam}/detail`, { settle: 4500 });

  // 护栏 1 / 2 —— 刚 goto 完「学科列表」可能还在转圈（实测偶发 spinner 不落），
  // 此时读行会得到 err:'no-label'。**这是渲染竞态，不是"行不存在"**，
  // 必须重试（第 2 次起重新 goto），否则会把可发布的条误判为失败。
  let st = null;
  for (let i = 0; i < 4; i++) {
    st = await s.val(JS.rowState(it.sub));
    if (!st.err) break;
    if (i < 3) {
      if (i >= 1) await s.goto(`${BASE}/exam/${it.exam}/detail`, { settle: 4500 });
      await sleep(2500);
    }
  }
  log.before = st;
  if (st.err) throw new Error('行读取失败 ' + st.err);
  if (st.paper !== String(it.paper)) throw new Error(`卷号不符 页面=${st.paper} 期望=${it.paper}`);
  if (st.published) { log.skipped = '已发布'; return log; }
  if (st.hasPubBtn !== true || st.pubDisabled) throw new Error('发布按钮不可用');

  const r1 = await s.val(JS.clickPub(it.sub));
  if (r1 !== 'ok') throw new Error('点发布失败 ' + r1);
  await sleep(3000);
  await s.until(JS.drawerOpen, { timeout: 15000 });

  await setPicker(s, 0, PUB, '发布时间');
  await setPicker(s, 1, END, '截止时间');

  const vals = await s.val(JS.pickerVals);               // 护栏 3
  log.picker = vals;
  if (vals[0] !== PUB.val || vals[1] !== END.val) {
    throw new Error(`时间设置异常 ${JSON.stringify(vals)}（期望 ${PUB.val} / ${END.val}），未提交`);
  }

  await s.val(JS.next);
  await s.until(JS.step2, { timeout: 15000 });
  await sleep(1200);

  log.checkManaged = await s.val(JS.checkManaged);
  await sleep(2500);
  log.classList = await s.val(JS.classState);
  log.selectRes = await s.val(JS.selectClasses);
  await sleep(1200);

  const cnt = await s.val(JS.counter);                   // 护栏 4
  const state = await s.val(JS.classState);
  log.selected = cnt;
  log.classNames = state;
  if (cnt !== CLASSES.length) throw new Error(`已选班级数=${cnt}，期望 ${CLASSES.length}，未提交`);
  for (const c of CLASSES) if (state[c] !== true) throw new Error(`班级 ${c} 未勾选，未提交`);
  const extra = Object.keys(state).filter(k => state[k] === true && !CLASSES.includes(k));
  if (extra.length) throw new Error(`多选了班级 ${extra.join(',')}，未提交`);

  await s.shot(`${SHOTS}/${tag}-before.png`);
  if (DRY) { log.dry = '未提交'; await s.val(JS.cancel); await sleep(1000); return log; }

  const r2 = await s.val(JS.submit);
  if (r2 !== 'ok') throw new Error('点发布任务失败 ' + r2);
  await s.until(JS.success, { timeout: 25000 });
  log.successText = await s.val(JS.successInfo);
  await s.shot(`${SHOTS}/${tag}-success.png`);
  await s.val(JS.dismiss);
  await sleep(2500);

  await s.goto(`${BASE}/exam/${it.exam}/detail`, { settle: 4500 });   // 护栏 5
  // 复核同样会撞上「学科列表还在转圈」→ 读到 err 会误判成"没发布成功"（假阴性），
  // 比读不到行更危险。同样重试；只有真读到行且 !published 才算失败。
  let after = null;
  for (let i = 0; i < 4; i++) {
    after = await s.val(JS.rowState(it.sub));
    if (!after.err) break;
    if (i < 3) {
      if (i >= 1) await s.goto(`${BASE}/exam/${it.exam}/detail`, { settle: 4500 });
      await sleep(2500);
    }
  }
  log.after = after;
  if (after.err) throw new Error('发布后复核：行读取失败 ' + after.err);
  if (!after.published) throw new Error('发布后复核：行仍未显示班级列表');
  // 只断言时间精确相等；班级数只记录（服务端会收窄，见文件头 ⚠️）
  if (after.time !== `${PUB.val} - ${END.val}`) throw new Error(`发布后复核：时间异常 ${after.time}`);
  await s.val(JS.scrollRow(it.sub));   // 让复核截图真的拍到这一行
  await sleep(1200);
  await s.shot(`${SHOTS}/${tag}-after.png`);
  log.ok = true;
  return log;
}

(async () => {
  const items = fs.readFileSync(ITEMS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const batch = items.slice(START, START + LIMIT);
  console.error(`发布参数: ${PUB.val} → ${END.val} | 班级 ${CLASSES.length} 个 | 目标 ${batch.length} 条${DRY ? ' [空跑]' : ''}`);
  let ok = 0, fail = 0, skip = 0;
  const s = new Session();
  for (const it of batch) {
    const tag = `${it.exam}-${it.sub}-${it.paper}`;
    const log = {};
    let rec = { ...it, ts: new Date().toISOString() };
    try {
      await publishOne(s, it, log);
      rec = Object.assign(rec, log);
      if (log.skipped) { skip++; console.error(`SKIP ${tag} ${log.skipped}`); }
      else if (log.dry) { console.error(`DRY  ${tag} 已选${log.selected}班 时间${JSON.stringify(log.picker)}`); }
      else { ok++; console.error(`OK   ${tag} 已选${log.selected}班 时间${JSON.stringify(log.picker)}`); }
    } catch (e) {
      fail++;
      rec = Object.assign(rec, log);
      rec.error = e.message.slice(0, 300);
      console.error(`FAIL ${tag} :: ${rec.error}`);
      try { await s.shot(`${SHOTS}/${tag}-ERROR.png`); } catch (x) {}
      try { await s.val(JS.cancel); } catch (x) {}
      await s.reset();
    }
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
  }
  console.error(`\n完成: 成功 ${ok} / 跳过 ${skip} / 失败 ${fail} / 共 ${batch.length}`);
  await s.reset();
  if (fail) process.exit(1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
