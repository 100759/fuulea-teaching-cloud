// 只读扫描：各「考试 × 学科」的阅卷分配模式（考试阅卷 / 任务阅卷）
//
// 用法:
//   node scan_marking_mode.js <items.jsonl> <out.jsonl> [start] [limit]
//
// items.jsonl 每行: {"exam":"29194","sub":"数学","paper":"81963863"}
//   也可以直接喂 `scan_publish_state.js` 的产物（一行一场考试、sub 是对象），会自动展开成
//   「已发布」的格子。
//
// 用途:
//   ① 改造前取基线、改造后复核（before/after 两份 jsonl 用 diff_marking_mode.py 对比）
//   ② 「哪些还是考试阅卷」的一次性台账
//
// ⚠️⚠️ 本脚本存在的**唯一理由**是一个极其容易踩的假阴性（2026-10-01 实测栽过）：
//   AntD 的 nz-radio-group **会先用默认值（考试阅卷）渲染，再由异步请求回填真实值**。
//   页面一渲染出 radio 就读 → 读到的是**默认值**。表现为：
//       "我刚把 43 条改成任务阅卷，独立复核却说 43 条仍是考试阅卷"（其实全改成功了）。
//   这比"漏改"危险得多 —— 会让你误以为写操作没生效，进而重复操作一个**不可逆**的设置。
//   ⇒ 因此本脚本**必须连续两次读数一致**才认账（见 readStable）。
//
// 另：切换成任务阅卷后，distribute 页 URL 的 `examStatus` 会从 11 变成 15，
//     可作为交叉验证的旁证（但不作为判据）。
const fs = require('fs');
const { sleep } = require(__dirname + '/cdp.js');
const { Session, BASE } = require(__dirname + '/session.js');

const ITEMS = process.argv[2];
const OUT = process.argv[3];
const START = Number(process.argv[4] || 0);
const LIMIT = Number(process.argv[5] || 0);
if (!ITEMS || !OUT) {
  console.error('用法: node scan_marking_mode.js <items.jsonl> <out.jsonl> [start] [limit]');
  process.exit(2);
}

const raw = fs.readFileSync(ITEMS, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
let items = [];
if (raw[0] && raw[0].sub && typeof raw[0].sub === 'object') {
  // scan_publish_state 产物：一行一场考试
  for (const r of raw) {
    for (const [sub, st] of Object.entries(r.sub || {})) {
      if (st && st.published) items.push({ exam: r.exam, examName: r.examName, sub, paper: st.paper });
    }
  }
} else {
  items = raw.filter(r => r.exam && r.sub)
    .map(r => ({ exam: r.exam, examName: r.examName, sub: r.sub, paper: r.paper }));
}
const batch = items.slice(START, LIMIT ? START + LIMIT : items.length);
console.log(`共 ${items.length} 条，本次查 ${batch.length} 条（start=${START}）`);

const OV = `(document.querySelector('.cdk-overlay-container')||document.body)`;
const JS = {
  click: sub => `(()=>{
    const lb=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='【${sub}】'&&e.offsetParent);
    if(!lb) return 'no-label';
    let row=lb; for(let i=0;i<8&&row;i++){ if(row.querySelector&&row.innerText&&row.innerText.includes('阅卷分配')) break; row=row.parentElement; }
    if(!row) return 'no-row';
    const b=[...row.querySelectorAll('button')].find(x=>x.innerText.trim()==='阅卷分配');
    if(!b) return 'no-btn'; if(b.disabled) return 'disabled'; b.click(); return 'ok';
  })()`,
  onPage: `(()=>location.href.includes('/offline/distribute/')&&document.body.innerText.includes('阅卷分配'))()`,
  read: `(()=>{const ov=${OV};
    const rs=[...ov.querySelectorAll('.ant-radio-wrapper')].filter(e=>e.offsetParent);
    return rs.map(e=>e.innerText.trim()+':'+(!!((e.querySelector('input')||{}).checked))).join('|');
  })()`,
};

// 连续两次读数一致才认账（见文件头 ⚠️）
async function readStable(s) {
  let prev = null;
  for (let i = 0; i < 8; i++) {
    const cur = await s.val(JS.read);
    if (prev !== null && cur === prev) return cur;
    prev = cur;
    await sleep(800);
  }
  return prev;   // 仍不稳定：把最后一次交出去，由 mode 判成"未知"
}

// 单格看门狗：标签被冻结时 `goto`/`ev` 会**无限挂住**，整批就卡死在那一条上
// （2026-10-01 实测）。超时就放弃这一格、重置会话继续下一格，最后统一重测失败的即可。
function withTimeout(p, ms, label) {
  let timer;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('看门狗超时 ' + ms + 'ms @' + label)), ms); }),
  ]);
}
const ITEM_TIMEOUT_MS = Number(process.env.MARKING_ITEM_TIMEOUT_MS || 60000);

(async () => {
  const s = new Session({});
  let ok = 0, err = 0;
  const cnt = {};
  for (const it of batch) {
    const rec = { ...it, ts: new Date().toISOString() };
    let needReset = false;
    try {
      await withTimeout((async () => {
        let r = 'init';
        for (let i = 0; i < 3; i++) {
          await s.goto(`${BASE}/exam/${it.exam}/detail`, { settle: 3000 });
          r = await s.val(JS.click(it.sub));
          if (r === 'ok') break;
          await sleep(2000);
        }
        if (r !== 'ok') throw new Error('点阅卷分配失败 ' + r);
        await s.until(JS.onPage, { timeout: 15000 });
        const stable = await readStable(s);
        rec.radios = stable;
        rec.mode = /任务阅卷:true/.test(stable) ? '任务阅卷'
          : (/考试阅卷:true/.test(stable) ? '考试阅卷' : '未知');
        const url = await s.val('location.href');
        rec.url = String(url).replace(/^https:\/\/[^/]+/, '');
        rec.examStatus = (rec.url.match(/examStatus=(\d+)/) || [])[1] || null;
      })(), ITEM_TIMEOUT_MS, `${it.exam}-${it.sub}`);
      rec.mode = rec.mode || '未知';
      cnt[rec.mode] = (cnt[rec.mode] || 0) + 1;
      ok++;
      console.log(`${ok + err}/${batch.length}  ${it.exam} ${it.sub} -> ${rec.mode} (examStatus=${rec.examStatus})`);
    } catch (e) {
      rec.err = e.message; err++; needReset = true;
      console.log(`${ok + err}/${batch.length}  ${it.exam} ${it.sub} -> ERR ${e.message}`);
    }
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
    if (needReset) { try { await s.reset(); } catch (x) {} }
  }
  console.log(`\n完成: 成功 ${ok} / 失败 ${err} | ${JSON.stringify(cnt)}`);
  console.log('提示: 不确定的条目请用「多次读数一致」再复核一遍，别直接下结论。');
  await s.reset();
  process.exit(err ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
