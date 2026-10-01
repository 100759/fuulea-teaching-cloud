#!/usr/bin/env node
// 批量给「班级」添加任课教师（CDP 驱动，绕开 agent-browser CLI 长任务冻结标签的问题）
//
// 用法:
//   node add_class_teachers.js <items.jsonl> <out.jsonl> [--limit N] [--start N] [--dry]
//                              [--shots <dir>] [--yes] [--settle ms]
//
// items.jsonl 每行:
//   {"class":"2024级9班","classId":"591219","subject":"数学","teacher":"张老师","phone":"13800000000"}
//
// 护栏:
//   1) 生产站(prod) 无 --yes 拒绝执行（--dry 不受限）
//   2) 幂等：班级教师列表里已有该老师 → 跳过
//   3) 每条先按手机号搜索，搜不到（下拉无匹配项）→ 标 failed，绝不点「添加」
//   4) 点完「添加」必须等到教师列表出现该姓名，否则标 failed
//   5) 有任何 failed → 退出码 1
//   6) 每个班级留 before/after 教师列表文本 + 截图（--shots 指定目录）
//
// 依赖: 同目录 cdp.js / session.js / login.js（复用 CDP 底座）
'use strict';

const fs = require('fs');
const path = require('path');
const { sleep } = require(__dirname + '/cdp.js');
const { Session } = require(__dirname + '/session.js');
const { BASE } = require(__dirname + '/login.js');

const ALIAS = process.env.FUULEA_ALIAS || 'lyyz';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
function has(name) { return process.argv.includes('--' + name); }

const [itemsPath, outPath] = process.argv.slice(2, 4);
if (!itemsPath || !outPath || itemsPath.startsWith('--')) {
  console.error('用法: node add_class_teachers.js <items.jsonl> <out.jsonl> [--limit N] [--start N] [--dry] [--shots dir] [--yes]');
  process.exit(2);
}
const DRY = has('dry');
const YES = has('yes');
const LIMIT = Number(arg('limit', 0)) || 0;
const START = Number(arg('start', 1)) || 1;
const SHOTS = arg('shots', '/tmp/fuulea/add-teacher-shots');
const SETTLE = Number(arg('settle', 2200)) || 2200;

const TIER = process.env.FUULEA_TIER || (ALIAS === 'test' ? 'test' : 'prod');
if (!DRY && TIER === 'prod' && !YES) {
  console.error(`✗ 拒绝执行：当前站点 ${ALIAS} (${TIER})，生产站写操作必须显式加 --yes`);
  process.exit(3);
}

const items = fs.readFileSync(itemsPath, 'utf8').split('\n')
  .map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));
const picked = items.slice(START - 1, LIMIT ? START - 1 + LIMIT : undefined);

// ---------- 页面内辅助 ----------
const INJECT = `
window.__fadd = {
  input: () => [...document.querySelectorAll('input.ant-select-selection-search-input')][1] || null,
  group: () => { const i = window.__fadd.input(); return i ? i.closest('.ant-select').parentElement : null; },
  addBtn: () => { const g = window.__fadd.group(); return g ? [...g.querySelectorAll('button')].find(b => b.innerText.trim() === '添加') : null; },
  options: () => [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].map(o => o.innerText.trim()),
  optEl: (ph) => [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find(o => o.innerText.trim().includes(ph)) || null,
  teachers: () => { const m = (document.body.innerText || '').match(/教师\\n([\\s\\S]*?)\\n学生/); return m ? m[1] : ''; },
  head: () => (document.body.innerText || '').split('\\n').slice(0, 12).join(' | ')
};
'ok';
`;

// nz-select 的搜索由真实按键触发；Input.insertText / 合成 input 事件都无效（已实测）
async function clearInput(page) {
  const r = await page.eval('(()=>{const i=window.__fadd.input(); return i ? (i.value||"") : "";})()');
  const v = r && r.value;
  if (!v) return;
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, commands: ['selectAll'] });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  await sleep(120);
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await sleep(200);
}

async function typeInto(page, elExpr, text) {
  await page.eval(`(()=>{const el=${elExpr}; if(!el) return 'nf'; el.focus(); return 'ok';})()`);
  await sleep(200);
  await clearInput(page);
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch, code: 'Digit' + ch, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Digit' + ch, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    await sleep(35);
  }
}

async function clickCenter(page, elExpr) {
  const r = await page.eval(`(()=>{const el=${elExpr}; if(!el) return null; const b=el.getBoundingClientRect(); if(!b.width) return {x:-1,y:-1}; return {x:b.x+b.width/2, y:b.y+b.height/2};})()`);
  const box = r.value;
  if (!box || box.x < 0) return false;
  const { x, y } = box;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(40);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 1, clickCount: 1 });
  return true;
}

const results = [];

(async () => {
  const S = new Session();
  const byClass = new Map();
  for (const it of picked) {
    if (!byClass.has(it.classId)) byClass.set(it.classId, []);
    byClass.get(it.classId).push(it);
  }

  fs.mkdirSync(SHOTS, { recursive: true });

  for (const [classId, list] of byClass) {
    const clsName = list[0].class;
    const url = `${BASE}/classroom/${classId}`;
    console.log(`\n=== ${clsName}  (${url})  待加 ${list.length} 位 ===`);

    await S.goto(url, { settle: SETTLE });
    await S.ev(INJECT);

    const before = (await S.val('window.__fadd.teachers()')) || '';
    console.log('  现有:', before.replace(/\n+/g, '|').slice(0, 400));

    for (const it of list) {
      const rec = { ...it, ts: new Date().toISOString(), result: 'pending' };
      try {
        // 幂等：已在该班教师列表里则跳过
        const nowList = (await S.val('window.__fadd.teachers()')) || '';
        if (nowList.includes(it.teacher)) {
          rec.result = 'skipped_already_present';
          console.log(`  - ${it.subject} ${it.teacher}: 已存在，跳过`);
          results.push(rec);
          continue;
        }

        if (DRY) { rec.result = 'dry'; console.log(`  - [dry] ${it.subject} ${it.teacher} ${it.phone}`); results.push(rec); continue; }

        await S.ev(INJECT); // 页面可能重渲染，重新挂辅助
        // 1) 按手机号搜索
        await typeInto(S.page, 'window.__fadd.input()', it.phone);
        await sleep(1600);
        const opts = (await S.val('window.__fadd.options()')) || [];
        rec.options = opts.slice(0, 5);
        const hit = opts.some(t => t.includes(it.phone));
        if (!hit) {
          rec.result = 'failed_no_such_teacher';
          console.log(`  ✗ ${it.subject} ${it.teacher}: 搜不到该手机号，候选=${JSON.stringify(opts)}`);
          await S.shot(path.join(SHOTS, `${clsName}-${it.teacher}-notfound.png`));
          results.push(rec);
          continue;
        }
        // 2) 选中候选项
        await clickCenter(S.page, `window.__fadd.optEl(${JSON.stringify(it.phone)})`);
        await sleep(600);
        // 3) 点「添加」
        const clicked = await clickCenter(S.page, 'window.__fadd.addBtn()');
        if (!clicked) {
          rec.result = 'failed_no_add_button';
          console.log(`  ✗ ${it.subject} ${it.teacher}: 找不到「添加」按钮`);
          results.push(rec); continue;
        }
        // 4) 等教师列表出现该姓名
        let ok = false;
        for (let i = 0; i < 20; i++) {
          await sleep(600);
          const t = (await S.val('window.__fadd.teachers()')) || '';
          if (t.includes(it.teacher)) { ok = true; break; }
        }
        rec.result = ok ? 'ok' : 'failed_not_applied';
        console.log(`  ${ok ? '✓' : '✗'} ${it.subject} ${it.teacher}${ok ? '' : '（点了添加但列表未出现该姓名）'}`);
        if (!ok) await S.shot(path.join(SHOTS, `${clsName}-${it.teacher}-fail.png`));
      } catch (e) {
        rec.result = 'error';
        rec.err = String(e.message || e).slice(0, 300);
        console.log(`  ✗ ${it.subject} ${it.teacher}: ${rec.err}`);
      }
      results.push(rec);
    }

    const after = (await S.val('window.__fadd.teachers()')) || '';
    if (after !== before) {
      fs.writeFileSync(path.join(SHOTS, `${clsName}-before.txt`), before);
      fs.writeFileSync(path.join(SHOTS, `${clsName}-after.txt`), after);
      await S.shot(path.join(SHOTS, `${clsName}-after.png`));
    }
    console.log('  完成后:', after.replace(/\n+/g, '|').slice(0, 400));
  }

  fs.writeFileSync(outPath, results.map(r => JSON.stringify(r)).join('\n') + '\n');
  const fail = results.filter(r => /^failed|^error/.test(r.result));
  const ok = results.filter(r => r.result === 'ok');
  const skip = results.filter(r => r.result === 'skipped_already_present');
  console.log(`\n汇总: ok=${ok.length} skipped=${skip.length} failed=${fail.length}  (共 ${results.length})`);
  console.log('明细:', outPath);
  console.log('留证:', SHOTS);
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
