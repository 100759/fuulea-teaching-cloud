// 登录 智慧教学云（CDP 版，幂等）
const fs = require('fs');
const os = require('os');
const { Page, sleep } = require(__dirname + '/cdp.js');
const BASE = process.env.FUULEA_BASE || 'https://lyyz.fuulea.com';
const ALIAS = process.env.FUULEA_ALIAS || 'lyyz';

function creds() {
  const f = `${os.homedir()}/.workbuddy/skills/fuulea-teaching-cloud/scripts/.credentials`;
  const line = fs.readFileSync(f, 'utf8').split('\n').find(l => l.startsWith(ALIAS + '|'));
  const [, acc, pwd] = line.split('|');
  return { acc: acc.trim(), pwd: pwd.trim() };
}

async function loggedIn(page) {
  const r = await page.eval(`(document.body.innerText||'').includes('题库')`);
  return !!r.value;
}

async function typeInto(page, selectorJs, text) {
  await page.eval(`(()=>{const el=${selectorJs}; if(!el) return 'nf'; el.focus(); el.select&&el.select(); return 'ok';})()`);
  await sleep(300);
  await page.send('Input.insertText', { text });
  await sleep(400);
}

async function login(page, { force = false } = {}) {
  await page.goto(`${BASE}/`);
  await sleep(3000);
  if (!force && await loggedIn(page)) return { ok: true, reused: true };

  // 切到「账号登录」
  await page.eval(`(()=>{const e=[...document.querySelectorAll('*')].find(x=>x.children.length===0&&x.textContent.trim()==='账号登录'); if(e) e.click(); return !!e;})()`);
  await sleep(1500);

  const { acc, pwd } = creds();
  const uSel = `document.querySelector('input[placeholder*="账号"]')`;
  const pSel = `document.querySelector('input[type="password"]') || document.querySelector('input[placeholder*="密码"]')`;
  await typeInto(page, uSel, acc);
  await typeInto(page, pSel, pwd);
  await sleep(500);

  await page.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='登录'); if(b){b.click(); return 'ok';} return 'nf';})()`);

  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    if (await loggedIn(page)) return { ok: true, reused: false };
  }
  const err = await page.eval(`(()=>document.body.innerText.slice(0,300))()`);
  return { ok: false, body: err.value };
}

async function ensure(page, opts) {
  const r = await login(page, opts);
  if (!r.ok) throw new Error('LOGIN_FAIL ' + JSON.stringify(r).slice(0, 400));
  return r;
}

module.exports = { login, ensure, loggedIn, BASE, creds };

if (require.main === module) {
  (async () => {
    const page = await Page.attach();
    const r = await ensure(page, { force: process.argv.includes('--force') });
    console.log('LOGIN', JSON.stringify(r));
    console.log('url', (await page.eval('location.href')).value);
    await page.close();
  })().catch(e => { console.error('ERR', e.message); process.exit(1); });
}
