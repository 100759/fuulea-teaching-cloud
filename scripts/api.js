// 智慧教学云 /v2 接口直连客户端（复刻前端 fl-sec-sign 签名）
//
// 背景：/v2 的 GET 请求需要 3 个头：Authorization(jwt)、uuid、fl-sec-sign。
// fl-sec-sign = `<murmurhash3_x64_128_hex>,<unix秒>`，签名串由
//   `${METHOD} ${path-with-trailing-slash}?${query}&none=${ts}&key=${k}&agent=${uuid}&uuid=${uuid}`
// 组成（query 为「key 小写 = value」按原 key 排序后 & 连接）。
// key 由 JWT 的签名段派生：sig[0:3] + sig[8:10] + sig[-5:]
// 算法取自 main-2GBQH3EH.js 的 axios 请求拦截器，2026-10-01 用真实抓包向量复现验证通过。
//
// 用法：
//   node api.js creds            # 从浏览器 localStorage 取 jwt/uuid → creds.json
//   node api.js selftest         # 用真实向量自检签名算法
const fs = require('fs');
const path = require('path');
const murmur = require('./murmur3.js');

const BASE = process.env.FUULEA_BASE || 'https://lyyz.fuulea.com';
const CREDS = path.join(__dirname, '.api-creds.json');

function signKey(jwtSig) { return jwtSig.substring(0, 3) + jwtSig.substring(8, 10) + jwtSig.substring(jwtSig.length - 5); }

function makeSigner({ jwt, uuid }) {
  const key = signKey(String(jwt).split('.').pop());
  return function sign(method, p, params = {}) {
    const ts = Math.floor(Date.now() / 1000);
    const sp = new URLSearchParams();
    for (const k in params) if (params[k] !== null && params[k] !== undefined) sp.set(k, params[k]);
    const q = Array.from(sp.keys()).sort().map(k => k.toLowerCase() + '=' + sp.get(k)).join('&').trim();
    const s = method + ' ' + p + '?' + q + '&none=' + ts + '&key=' + key + '&agent=' + uuid + '&uuid=' + uuid;
    return { sign: murmur.hex32(new TextEncoder().encode(s)), none: ts };
  };
}

class Api {
  constructor({ jwt, uuid }) { this.jwt = jwt; this.uuid = uuid; this.sign = makeSigner({ jwt, uuid }); }
  headers(path) {
    return {
      'Authorization': 'jwt ' + this.jwt,
      'uuid': this.uuid,
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': BASE + '/task',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    };
  }
  async raw(pathname, params = {}) {
    return this.request('GET', pathname, { params });
  }
  // 通用请求（支持 GET/POST/PUT/DELETE，可带 body）
  async request(method, pathname, { params = {}, body = null, extraHeaders = {} } = {}) {
    const { sign, none } = this.sign(method, pathname, params);
    const qs = new URLSearchParams();
    for (const k in params) if (params[k] !== null && params[k] !== undefined) qs.set(k, params[k]);
    const url = BASE + pathname + (Object.keys(params).length ? '?' + qs.toString() : '');
    const h = this.headers(pathname);
    h['fl-sec-sign'] = sign + ',' + none;
    h['Referer'] = BASE + '/task/import';
    Object.assign(h, extraHeaders);
    return fetch(url, { method, headers: h, body });
  }
  async get(pathname, params = {}) {
    const res = await this.raw(pathname, params);
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, json, text };
  }
  // 表单上传（multipart/form-data）。form 为 FormData。
  // 签名与前端一致：只签 method + pathname + query，不含 body。
  async postForm(pathname, form, params = {}) {
    const res = await this.request('POST', pathname, { params, body: form });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, json, text };
  }
  async postJson(pathname, obj, params = {}) {
    const res = await this.request('POST', pathname, {
      params, body: JSON.stringify(obj), extraHeaders: { 'Content-Type': 'application/json' },
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, json, text };
  }
  // 取二进制（如下载模板）
  async getBinary(pathname, params = {}) {
    const res = await this.raw(pathname, params);
    if (res.status !== 200) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 150));
    return Buffer.from(await res.arrayBuffer());
  }
}

function loadCreds() {
  if (!fs.existsSync(CREDS)) throw new Error('缺少 ' + CREDS + '，先跑: node api.js creds');
  return JSON.parse(fs.readFileSync(CREDS, 'utf8'));
}

module.exports = { Api, makeSigner, loadCreds, CREDS, BASE, signKey };

// ---------------------------------------------------------------- CLI
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'selftest') {
    // 2026-10-01 真实抓包向量
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjo5MDEzNDMsInVzZXJuYW1lIjoibHl5emFkbWluIiwiZXhwIjoxNzkwODIxNDQzLCJwYXMiOiJkMTFmZDNmNWUwMzllMDc5NTk1YmM1ZWVjODIwMzMyNCIsInN1YmplY3RfaWQiOjJ9._ZkSNF4ax0eu51BRPD6WVqoL1s7UxyqVOq337XXYiFc';
    const key = signKey(jwt.split('.').pop());
    const params = { siteId: 859, teacherId: 901343, noTaskIntelli: true, isDeleted: false, publishedOnly: false, noMaterialTask: false, noVocabulary: false, mySelfOnly: false, includeSameGradeData: false, mergeTaskPack: false, type: 0, page: 1, location: '', excludeUnsubmited: false, publishStatus: 2 };
    const sp = new URLSearchParams();
    for (const k in params) sp.set(k, params[k]);
    const q = Array.from(sp.keys()).sort().map(k => k.toLowerCase() + '=' + sp.get(k)).join('&');
    const s = 'GET /v2/tasks/?' + q + '&none=1790817844&key=' + key + '&agent=v3_1687480797&uuid=v3_1687480797';
    const got = murmur.hex32(new TextEncoder().encode(s));
    const want = 'cc3038a2ec6f20e082b9dbb8f0eefa43';
    console.log('key =', key);
    console.log('got =', got);
    console.log('want=', want);
    console.log(got === want ? 'SELFTEST OK' : 'SELFTEST FAIL');
    process.exit(got === want ? 0 : 1);
  }
  if (cmd === 'creds') {
    (async () => {
      const { Page, sleep } = require(__dirname + '/cdp/cdp.js');
      // 2026-10-01 修：agent-browser 的会话名是 `fuulea-<站点别名>`（login.sh 里设的）。
      // 不显式指定时，cdp-url 会指到当前默认/上一次用过的会话 —— 那个会话很可能是登出状态，
      // 于是 localhost 读不到 jwt-token，脚本却报「先确认已登录」，指向完全错误的排查方向。
      //   → 允许 `node api.js creds <别名>` 显式指定站点；没给就沿用 env，并在失败时打印实际看到的 URL。
      const alias = process.argv[3];
      if (alias) process.env.AGENT_BROWSER_SESSION = 'fuulea-' + alias;
      const sess = process.env.AGENT_BROWSER_SESSION || '(未设置 → 会用 agent-browser 默认会话)';
      console.log('site=' + BASE + '  session=' + sess);
      let lastSeen = '(未知)';
      for (let i = 0; i < 6; i++) {
        let page;
        try {
          page = await Page.attach();
          await page.keepAwake();
          await page.goto(BASE + '/task', { settle: 3000 });
          const r = await page.eval("(()=>({url:location.href,jwt:localStorage.getItem('jwt-token'),uuid:localStorage.getItem('uuid')}))()", { timeout: 8000 });
          const v = r.value || {};
          lastSeen = v.url || lastSeen;
          if (v.jwt && v.uuid) {
            fs.writeFileSync(CREDS, JSON.stringify({ jwt: v.jwt, uuid: v.uuid, at: new Date().toISOString(), base: BASE }, null, 1));
            fs.chmodSync(CREDS, 0o600);
            console.log('CREDS OK uuid=' + v.uuid);
            await page.close();
            return;
          }
        } catch (e) { console.log('attempt ' + (i + 1) + ': ' + e.message); }
        try { page && await page.close(); } catch (e) {}
        await sleep(2000);
      }
      console.error('CREDS FAIL');
      console.error('  会话: ' + sess);
      console.error('  看到的是: ' + lastSeen);
      if (/[?&]next=/.test(lastSeen)) {
        console.error('  → 页面被踢回首页（未登录）。先跑: bash scripts/login.sh ' + (alias || '<别名>'));
        console.error('  → 若刚登录过仍如此，多半是会话名不对：加别名重跑  node api.js creds <别名>');
      } else {
        console.error('  → 大概率是会话名不对（连到了别的会话）。加别名重跑: node api.js creds <别名>');
      }
      process.exit(1);
    })();
    return;
  }
  console.log('用法: node api.js creds [别名] | selftest');
}
