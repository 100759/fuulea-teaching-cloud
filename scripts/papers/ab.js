#!/usr/bin/env node
// agent-browser 驱动公共层 —— 供 scan_matrix.js / scan_course.js / verify_bindings.js require
//
// 提供的都是"踩过坑之后"的版本，别在调用方里另起炉灶：
//   ab(args)                 执行 agent-browser 命令
//   ev(expr)                 执行页面 JS 并把结果当 JSON 解析
//   sleep(s)
//   poll(fn, tries, first, wait)   轮询到 fn() 返回真值（不要用固定 sleep 赌渲染）
//   openChecked(url, opts)   打开并**确认真的渲染出来**，失败自动硬重置会话再试
//   resetSession()           硬重置当前会话（调 FUULEA_RESET，即 scripts/browser.sh）
//
// 会话：优先用调用方传入的 AGENT_BROWSER_SESSION（exam_papers.sh 会注入 fuulea-<别名>）。
// ⚠️ 不要用默认会话 `default`：全机共享；且会话状态文件坏掉时 `open` 会"假成功"
//    而页面停在 about:blank。详见 scripts/browser.sh 头部。
const { execFileSync } = require('child_process');

process.env.AGENT_BROWSER_SESSION = process.env.AGENT_BROWSER_SESSION || 'fuulea-default';

function ab(args) {
  return execFileSync('agent-browser', args, { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
}
function ev(expr) {
  const raw = ab(['eval', expr]);
  try { return JSON.parse(raw); } catch (e) { return { __raw: raw }; }
}
function sleep(s) { execFileSync('sleep', [String(s)]); }

function poll(fn, tries, firstWait, wait) {
  let last = null;
  for (let k = 0; k < tries; k++) {
    sleep(k === 0 ? firstWait : wait);
    last = fn();
    if (last) return last;
  }
  return last;
}

// 硬重置：交给 scripts/browser.sh（close --all + 杀守护进程 + 删会话状态文件）
function resetSession() {
  const sh = process.env.FUULEA_RESET;
  if (sh) {
    try { execFileSync('bash', [sh, 'hard-reset'], { stdio: 'inherit' }); return; } catch (e) {}
  }
  try { ab(['close']); } catch (e) {}
  sleep(3);
}

// 打开 URL 并确认真的渲染出来了：URL 不是 about:blank、body 非空、（可选）选择器存在。
// 失败就硬重置会话再整轮重试。返回 boolean。
function openChecked(url, opts) {
  const o = Object.assign({ tries: 3, sel: null, minLen: 1 }, opts || {});
  for (let i = 1; i <= o.tries; i++) {
    try { ab(['open', url]); } catch (e) {}
    for (let k = 0; k < 8; k++) {
      sleep(k === 0 ? 3 : 2);
      let cur = '';
      try { cur = ab(['get', 'url']); } catch (e) {}
      if (!cur || cur === 'about:blank') continue;
      const len = ev('document.body?document.body.innerText.length:0');
      if (!(typeof len === 'number' && len >= o.minLen)) continue;
      if (o.sel) {
        const n = ev(`document.querySelectorAll(${JSON.stringify(o.sel)}).length`);
        if (!(typeof n === 'number' && n > 0)) continue;
      }
      return true;
    }
    console.error(`  (第 ${i} 次打开未渲染成功 url=${url}；硬重置会话 ${process.env.AGENT_BROWSER_SESSION})`);
    resetSession();
  }
  return false;
}

module.exports = { ab, ev, sleep, poll, openChecked, resetSession };
