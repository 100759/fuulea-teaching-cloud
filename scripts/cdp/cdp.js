// 轻量 CDP 客户端：绕开 agent-browser CLI 的 about:blank/会话抖动问题
const { execFileSync } = require('child_process');

function cdpPort() {
  const cdp = execFileSync('agent-browser', ['get', 'cdp-url'], { encoding: 'utf8' }).trim();
  const m = cdp.match(/127\.0\.0\.1:(\d+)/);
  if (!m) throw new Error('cdp-url not found (agent-browser 未启动？): ' + cdp.slice(0, 120));
  return m[1];
}

// 默认优先匹配的站点主机：由 FUULEA_BASE 推导，避免把生产站写死进通用层
function preferHost() {
  try { return new URL(process.env.FUULEA_BASE || 'https://lyyz.fuulea.com').host; }
  catch (e) { return 'lyyz.fuulea.com'; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fs = require('fs');

class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; this.listeners = []; }

  static async attach(prefer = preferHost()) {
    const port = cdpPort();
    let targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    let t = targets.find(x => x.type === 'page' && x.url.includes(prefer))
      || targets.find(x => x.type === 'page' && x.url.includes('fuulea.com'))
      || targets.find(x => x.type === 'page' && !x.url.startsWith('chrome://'))
      || targets.find(x => x.type === 'page');
    if (!t) throw new Error('no page target');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    const p = new Page(ws);
    p.targetId = t.id;
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && p.pending.has(m.id)) { p.pending.get(m.id)(m); p.pending.delete(m.id); return; }
      p.events.push(m);
      // 事件缓冲区必须有上限：开着 Network.enable 时事件是洪流，
      // 不封顶会一路吃内存并把主线程拖慢，最后表现为 Runtime.evaluate 超时。
      if (p.events.length > 4000) p.events.splice(0, 2000);
      for (const l of p.listeners) l(m);
    };
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    await p.send('Page.enable');
    await p.send('Runtime.enable');
    // 关键：Chrome 会把后台标签「冻结/丢弃」→ 表现为 about:blank / eval 卡死
    await p.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
    await p.send('Target.activateTarget', { targetId: t.id }).catch(() => {});
    return p;
  }

  send(method, params = {}, timeout = 12000) {
    return new Promise((res, rej) => {
      const mid = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(mid); rej(new Error('cdp timeout ' + method)); }, timeout);
      this.pending.set(mid, m => { clearTimeout(timer); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); });
      this.ws.send(JSON.stringify({ id: mid, method, params }));
    });
  }

  // 注册监听器；返回"摘除"函数（务必在 finally 里调用，否则会累积）
  on(fn) {
    this.listeners.push(fn);
    return () => { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); };
  }

  async goto(url, { timeout = 30000, settle = 2500 } = {}) {
    this.events.length = 0;
    let loaded = false;
    const handler = m => { if (m.method === 'Page.loadEventFired') loaded = true; };
    // 监听器用完必须摘掉。以前是 this.on(handler) 之后再没移除：
    // 每次 goto 都往 this.listeners 里塞一个，N 次导航后**每个 CDP 事件都要跑 N 个回调**，
    // 打开 Network 时事件是洪流 → Node 侧被拖死 → "cdp timeout Runtime.evaluate"。
    // 2026-10-01 批量下载 150 份模板时稳定复现（第 4~9 次导航必挂）。
    const off = this.on(handler);
    try {
      await this.send('Page.navigate', { url });
      const t0 = Date.now();
      while (!loaded && Date.now() - t0 < timeout) await sleep(300);
      await sleep(settle);
      await this.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
      // 收尾读取 URL 只是"报告用"，**不能让它把整个导航判死**：
      // 页面重渲染时 Runtime.evaluate 偶发卡到超时，此时页面其实已经好了。
      try { return (await this.eval('location.href', { timeout: 8000 })).value; }
      catch (e) { return null; }
    } finally { off(); }
  }

  async keepAwake() {
    await this.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
    await this.send('Target.activateTarget', { targetId: this.targetId }).catch(() => {});
  }

  // 带重试的 eval：卡死时重新激活标签并重试
  async ev(expr, tries = 3) {
    for (let i = 0; i < tries; i++) {
      try { return await this.eval(expr, { awaitPromise: true }); }
      catch (e) {
        if (i === tries - 1) throw e;
        await this.keepAwake();
        await sleep(800);
      }
    }
  }

  async eval(expr, { awaitPromise = true, timeout = 12000 } = {}) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }, timeout);
    if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return { value: r.result.value, type: r.result.type };
  }

  // 轮询直到 expr 返回真值
  async until(expr, { timeout = 20000, interval = 500 } = {}) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      try { last = (await this.ev(expr)).value; if (last) return last; } catch (e) { last = 'err:' + e.message.slice(0, 80); }
      await sleep(interval);
    }
    throw new Error(`until timeout: ${expr.slice(0, 80)} last=${JSON.stringify(last)}`);
  }

  async shot(path) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path, Buffer.from(r.data, 'base64'));
  }

  async close() { try { this.ws.close(); } catch (e) {} }
}

module.exports = { Page, sleep, cdpPort, preferHost };
