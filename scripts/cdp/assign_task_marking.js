// 智慧教学云 · 阅卷分配 → 「任务阅卷」（生产站写操作）
//
// ⚠️ 不可逆：页面原文「"任务阅卷"开启后…将无法重新设置为"考试阅卷"，请谨慎使用。」
//    动手前必须跟用户确认范围，且只动本次新发布的任务。
//
// 用法:
//   node assign_task_marking.js <items.jsonl> <out.jsonl> [--shots <dir>] [--limit N] [--start N] [--dry]
//
// items.jsonl 每行: {"exam":"29194","examName":"…","sub":"地理","paper":"81813364"}
//
// 流程: 考试详情 → 学科行「阅卷分配」→ /exam/:id/offline/distribute/:esId/teachers
//       → 选「任务阅卷」→ 保存 → **重新打开该页确认已持久化**
const fs = require('fs');
const { sleep } = require(__dirname + '/cdp.js');
const { Session, BASE } = require(__dirname + '/session.js');

const args = process.argv.slice(2);
const ITEMS = args[0];
const OUT = args[1];
const DRY = args.includes('--dry');
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const START = args.includes('--start') ? Number(args[args.indexOf('--start') + 1]) : 0;
const SHOTS = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : '/tmp/fuulea/assign-shots';
fs.mkdirSync(SHOTS, { recursive: true });

const OV = `(document.querySelector('.cdk-overlay-container')||document.body)`;

const JS = {
  rowState: sub => `(()=>{
    const lb=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='【${sub}】'&&e.offsetParent);
    if(!lb) return {err:'no-label'};
    let row=lb; for(let i=0;i<8&&row;i++){ if(row.querySelector&&row.innerText&&row.innerText.includes('阅卷分配')) break; row=row.parentElement; }
    if(!row) return {err:'no-row'};
    const txt=row.innerText.replace(/\\s+/g,' ').trim();
    const m=txt.match(/考试内容[:：](\\d+)/);
    const b=[...row.querySelectorAll('button')].find(x=>x.innerText.trim()==='阅卷分配');
    return { paper:m?m[1]:null, published:/20\\d\\d级\\d+班/.test(txt), text:txt.slice(0,220),
      hasBtn:!!b, btnDisabled: b?!!(b.disabled||getComputedStyle(b).color==='rgba(0, 0, 0, 0.25)'):null };
  })()`,
  clickAssign: sub => `(()=>{
    const lb=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='【${sub}】'&&e.offsetParent);
    if(!lb) return 'no-label';
    let row=lb; for(let i=0;i<8&&row;i++){ if(row.querySelector&&row.innerText&&row.innerText.includes('阅卷分配')) break; row=row.parentElement; }
    const b=[...row.querySelectorAll('button')].find(x=>x.innerText.trim()==='阅卷分配');
    if(!b) return 'no-btn'; if(b.disabled) return 'disabled'; b.click(); return 'ok';
  })()`,
  onPage: `(()=>location.href.includes('/offline/distribute/')&&document.body.innerText.includes('阅卷分配'))()`,
  radioState: `(()=>{const ov=${OV};
    return [...ov.querySelectorAll('.ant-radio-wrapper')].filter(e=>e.offsetParent).map(e=>({t:e.innerText.trim(), checked:!!(e.querySelector('input')||{}).checked}));
  })()`,
  pickTask: `(()=>{const ov=${OV};
    const w=[...ov.querySelectorAll('.ant-radio-wrapper')].find(e=>e.innerText.trim()==='任务阅卷');
    if(!w) return 'nf';
    const inp=w.querySelector('input');
    if(inp&&inp.checked) return 'already';
    (w.querySelector('.ant-radio')||w).click(); return 'clicked';})()`,
  modal: `(()=>{const m=[...document.querySelectorAll('.ant-modal')].filter(e=>e.offsetParent).pop();if(!m)return null;
    return {text:m.innerText.replace(/\\n{2,}/g,'\\n').trim().slice(0,300), btns:[...m.querySelectorAll('button')].map(b=>b.innerText.trim())}})()`,
  modalOk: `(()=>{const m=[...document.querySelectorAll('.ant-modal')].filter(e=>e.offsetParent).pop();if(!m)return 'nf';
    const b=[...m.querySelectorAll('button')].find(x=>/确定|确认|好的/.test(x.innerText.trim()));if(!b)return 'nf';b.click();return 'ok'})()`,
  save: `(()=>{const ov=${OV};const b=[...ov.querySelectorAll('button')].find(x=>x.innerText.trim()==='保存');if(!b)return 'nf';b.click();return 'ok'})()`,
  toast: `(()=>[...document.querySelectorAll('.ant-message-notice, .ant-notification-notice')].map(e=>e.innerText.trim()))()`,
};

const taskChecked = rs => (rs.find(x => x.t === '任务阅卷') || {}).checked;

(async () => {
  const items = fs.readFileSync(ITEMS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const batch = items.slice(START, START + LIMIT);
  console.error(`阅卷分配→任务阅卷（不可逆）| 目标 ${batch.length} 条${DRY ? ' [空跑]' : ''}`);
  let ok = 0, fail = 0;
  const s = new Session();

  for (const it of batch) {
    const tag = `${it.exam}-${it.sub}-${it.paper}`;
    const log = {};
    let rec = { ...it, ts: new Date().toISOString() };
    try {
      await s.goto(`${BASE}/exam/${it.exam}/detail`, { settle: 4500 });
      // 「学科列表」偶发还在转圈 → 读行得到 err。这是渲染竞态而非"行不存在"，必须重试
      for (let i = 0; i < 4; i++) {
        log.before = await s.val(JS.rowState(it.sub));
        if (!log.before.err) break;
        if (i < 3) {
          if (i >= 1) await s.goto(`${BASE}/exam/${it.exam}/detail`, { settle: 4500 });
          await sleep(2500);
        }
      }
      if (log.before.err) throw new Error('行读取失败 ' + log.before.err);
      if (!log.before.published) throw new Error('该学科尚未发布，跳过');
      if (log.before.btnDisabled) throw new Error('阅卷分配按钮不可用');

      const r = await s.val(JS.clickAssign(it.sub));
      if (r !== 'ok') throw new Error('点阅卷分配失败 ' + r);
      await s.until(JS.onPage, { timeout: 20000 });
      await sleep(2500);
      log.url = await s.val('location.href');

      log.radioBefore = await s.val(JS.radioState);
      log.pickTask = await s.val(JS.pickTask);
      await sleep(1500);
      const md = await s.val(JS.modal);
      if (md) { log.modal = md; await s.val(JS.modalOk); await sleep(1500); }
      log.radioAfter = await s.val(JS.radioState);
      if (!taskChecked(log.radioAfter)) throw new Error('任务阅卷未被选中');

      await s.shot(`${SHOTS}/${tag}-before-save.png`);
      if (DRY) {
        log.dry = '未保存';
        rec = Object.assign(rec, log);
        fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
        console.error(`DRY  ${tag} 勾选已就绪`);
        continue;
      }

      const sv = await s.val(JS.save);
      if (sv !== 'ok') throw new Error('点保存失败 ' + sv);
      await sleep(2500);
      const md2 = await s.val(JS.modal);
      if (md2) { log.modal2 = md2; await s.val(JS.modalOk); await sleep(1500); }
      log.toast = await s.val(JS.toast);
      await s.shot(`${SHOTS}/${tag}-saved.png`);

      // 复核：重载该页确认已持久化
      await s.goto(log.url, { settle: 4500 });
      log.recheck = await s.val(JS.radioState);
      if (!taskChecked(log.recheck)) throw new Error('保存后复核：任务阅卷未持久化');

      log.ok = true; ok++;
      rec = Object.assign(rec, log);
      console.error(`OK   ${tag} 任务阅卷已保存`);
    } catch (e) {
      fail++;
      rec = Object.assign(rec, log);
      rec.error = e.message.slice(0, 300);
      console.error(`FAIL ${tag} :: ${rec.error}`);
      try { await s.shot(`${SHOTS}/${tag}-ERROR.png`); } catch (x) {}
      await s.reset();
    }
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
  }
  console.error(`\n完成: 成功 ${ok} / 失败 ${fail} / 共 ${batch.length}`);
  await s.reset();
  if (fail) process.exit(1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
