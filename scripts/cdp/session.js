// 可自愈的会话：CDP 掉线/标签被重置时自动重连
const { Page, sleep } = require(__dirname + '/cdp.js');
const { ensure, BASE } = require(__dirname + '/login.js');

class Session {
  constructor(opts = {}) { this.page = null; this.opts = opts; }

  async get() {
    if (!this.page) {
      this.page = await Page.attach();
      await this.page.keepAwake();
      await ensure(this.page);
      await this.page.keepAwake();
    }
    return this.page;
  }

  async reset() {
    if (this.page) { try { await this.page.close(); } catch (e) {} }
    this.page = null;
    await sleep(1500);
  }

  async goto(url, o = {}) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try { const p = await this.get(); return await p.goto(url, o); }
      catch (e) { lastErr = e; await this.reset(); }
    }
    throw new Error('goto failed ' + url + ' :: ' + lastErr.message);
  }

  async ev(expr) {
    let lastErr;
    for (let i = 0; i < 4; i++) {
      try { const p = await this.get(); return await p.ev(expr); }
      catch (e) { lastErr = e; await this.reset(); }
    }
    throw new Error('eval failed :: ' + lastErr.message);
  }

  async val(expr) { return (await this.ev(expr)).value; }

  async until(expr, o = {}) {
    try { const p = await this.get(); return await p.until(expr, o); }
    catch (e) { await this.reset(); const p = await this.get(); return p.until(expr, o); }
  }

  async shot(path) { const p = await this.get(); await p.shot(path); }

  async click(js) { return this.val(js); }

  async type(selectorJs, text) {
    await this.val(`(()=>{const el=${selectorJs}; if(!el) return 'nf'; el.focus(); try{el.setSelectionRange(0,(el.value||'').length);}catch(e){} return 'ok';})()`);
    await sleep(300);
    const p = await this.get();
    await p.send('Input.insertText', { text });
    await sleep(400);
    return true;
  }

  async key(key) {
    const p = await this.get();
    const map = { Enter: { windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' }, Tab: { windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' }, Escape: { windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' } };
    const k = map[key] || map.Enter;
    await p.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, k));
    await p.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, k));
  }
}

module.exports = { Session, BASE };
