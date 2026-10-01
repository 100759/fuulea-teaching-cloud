// 会话引导：连上 CDP → 确保登录 → 返回 page
const { Page, sleep } = require(__dirname + '/cdp.js');
const { ensure, BASE } = require(__dirname + '/login.js');

async function boot({ goto = null, settle = 3000 } = {}) {
  const page = await Page.attach();
  await page.keepAwake();
  await ensure(page);
  await page.keepAwake();
  if (goto) { await page.goto(BASE + goto, { settle }); await page.keepAwake(); }
  return page;
}

module.exports = { boot, BASE };
