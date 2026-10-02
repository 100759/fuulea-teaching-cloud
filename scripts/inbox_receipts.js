#!/usr/bin/env node
/**
 * inbox 回执对账 —— 判断「上传到底被平台收下了没」的唯一可信入口。
 *
 * 为什么必须有这个脚本（2026-10-01 / 10-02 两次实栽）：
 *
 *  1. `upload_task_scores.js` 的 `ok:true` **只代表接口返回 `{}`（已提交）**，
 *     不代表平台收下了分数。10-01 有一整份 116 行 × 23 列空格的英语被**整份拒收**
 *     （inbox id 119842374，`分数格式错误[行,列]` 2668 格），而当天报告按
 *     「接口返 {}」统计成「108 份成功、无错误」—— 一名学生都没导进去。
 *
 *  2. `content` 字段是**双层转义**的 JSON 字符串。直接
 *     `content.includes('汉字')` **恒为 false**，会让人误判「没有这条回执」。
 *
 *  3. 时间字段叫 **`createAt`**（不是 `createdAt`），且是 **UTC**，
 *     比北京时间**小 8 小时** —— 直接当本地时间读会差一天。
 *
 * 用法：
 *   node inbox_receipts.js                      # 总览 + 最近 N 条导入回执
 *   node inbox_receipts.js --limit 40
 *   node inbox_receipts.js --grep "第一学期高一期末考试"   # 只看某场考试
 *   node inbox_receipts.js --since "2026-10-02T06:00"    # 只看某时刻之后(UTC)
 *   node inbox_receipts.js --expect 6                      # 断言本批成功份数
 *   node inbox_receipts.js --out /tmp/inbox.json          # 落盘(已解码)
 *
 * 退出码：0 = 通过；3 = 有导入回执是 error（平台拒收）；4 = --expect 不符；5 = 未登录/凭据失效
 */
const path = require('path');
const fs = require('fs');
const m = require(path.join(__dirname, 'api.js'));

/**
 * 判定一条回执是成功还是被拒收，并把中文解成可读文本。
 *
 * ⚠️ 2026-10-02 实测确认的三层结构（每层都踩过坑）：
 *   content 是**双层转义**的 JSON 字符串；解一层后得到
 *     {"success": {"<文件名>": "导入学生: N"}, "error": {}, "title": "<文件名>"}
 *   1. 判据必须是「**error 里有没有内容**」—— 因为被拒时 `success` 是**空对象 `{}`**，
 *      用 `if (j.success)` 判断会把拒收误判成成功（10-01 那份被整份拒收的英语就这么漏过）。
 *   2. 成功时文件名/人数在 `j.success` 里，`j.title` 才是文件名；
 *      早期版本只扫顶层键，于是把 168 条全判成失败（假警报）。
 *   3. 解码后中文仍是 `\uXXXX` 转义，直接 `includes('汉字')` 恒 false → 再解一层。
 */
function dec(s) {
  let t = String(s);
  for (let i = 0; i < 2; i++) {
    try {
      const v = JSON.parse('"' + t.replace(/"/g, '\\"') + '"');
      if (typeof v !== 'string') return v;
      t = v;
    } catch (e) { break; }
  }
  return t;
}

function brief(content) {
  const c = dec(content);
  let j = null;
  try { j = JSON.parse(c); } catch (e) { /* 不是 JSON，按成功处理 */ }
  if (!j || typeof j !== 'object') return { ok: true, text: c.slice(0, 200) };

  const err = j.error;
  const hasErr = err && typeof err === 'object' && Object.keys(err).length > 0;
  if (hasErr) return { ok: false, text: JSON.stringify(err) };

  const succ = (j.success && typeof j.success === 'object') ? j.success : {};
  const pairs = Object.entries(succ);
  if (pairs.length) return { ok: true, text: JSON.stringify(Object.fromEntries(pairs)) };
  return { ok: true, text: c.slice(0, 200) };
}

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const LIMIT = parseInt(arg('--limit', '25'), 10);
const GREP = arg('--grep', '');
const SINCE = arg('--since', '');
const EXPECT = arg('--expect', null);
const OUT = arg('--out', '');

(async () => {
  const api = new m.Api(m.loadCreds());
  let first;
  try {
    first = await api.get('/v2/inbox/trainer/', { page: 1 });
  } catch (e) {
    console.error('请求失败：%s\n⇒ 凭据可能已过期，先跑：bash login.sh <别名> && node api.js creds <别名>', e.message);
    process.exit(5);
  }
  if (first.status === 401) {
    console.error('HTTP 401 ⇒ JWT 已过期（约 6 小时）。重跑：bash login.sh lyyz && node api.js creds lyyz');
    process.exit(5);
  }
  const count = (first.json && first.json.count) || 0;

  const all = [];
  for (let p = 1; p <= 30; p++) {
    const r = await api.get('/v2/inbox/trainer/', { page: p });
    const arr = (r.json && (r.json.results || r.json.data)) || [];
    if (!arr.length) break;
    all.push(...arr);
  }

  const imports = all.filter(x => x.title === '导入任务数据');
  console.log('inbox 总条数 %d（接口 count=%d）；其中「导入任务数据」%d 条', all.length, count, imports.length);

  // 时间是 UTC，比北京时间小 8 小时
  const toUtcCut = s => (s ? new Date(s).getTime() : -Infinity);
  const cut = toUtcCut(SINCE);
  const hit = imports.filter(x => {
    const t = Date.parse(x.createAt);
    if (!(t >= cut)) return false;
    if (!GREP) return true;
    return (dec(x.content) + ' ' + dec(x.title)).includes(GREP);
  });
  hit.sort((a, b) => String(b.createAt).localeCompare(String(a.createAt)));

  console.log('\n=== 导入回执（新→旧，最多 %d 条）%s ===', LIMIT,
    GREP ? '　筛选：' + GREP : (SINCE ? '　since ' + SINCE + '(UTC)' : ''));
  if (!hit.length) console.log('（无 —— ⚠️ 若你确信传过，说明时间窗/关键字不对，别当成「平台没收到」）');
  let bad = 0;
  hit.slice(0, LIMIT).forEach(x => {
    const b = brief(x.content);
    if (!b.ok) bad++;
    // 文件名是「平台原件命名法」（<考试名> <学科>班级对照表 (1).xlsx）时，
    // 说明是**别人**在本机/平台侧上传的，不是我方命名（我方一律叫「学科.xlsx」）
    const m2 = b.text.match(/([^\\/"]+\.xlsx)/);
    const fname = m2 ? m2[1] : '';
    const foreign = /班级对照表/.test(fname);
    console.log('  %s | %s%s | %s',
      x.createAt, b.ok ? '成功' : '❌失败', foreign ? ' [平台原件命名→疑似非我方]' : '', b.text.slice(0, 160));
  });

  // 全量统计不受 --limit 影响
  const allBad = hit.filter(x => !brief(x.content).ok);
  console.log('\n=== 判定 ===');
  console.log('本筛选范围内：成功 %d 条，失败 %d 条', hit.length - allBad.length, allBad.length);
  if (allBad.length) {
    console.log('失败回执：');
    allBad.forEach(x => console.log('  %s | %s', x.createAt, brief(x.content).text.slice(0, 200)));
  }
  if (EXPECT !== null) {
    const n = parseInt(EXPECT, 10);
    const succ = hit.length - allBad.length;
    if (succ !== n) {
      console.error('✗ --expect %d 不符：实际成功 %d 条。请核对漏传/多传，别只看脚本的 fail=0。', n, succ);
      process.exit(4);
    }
    console.log('✓ --expect %d 相符', n);
  }
  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify(all.map(x => ({ ...x, content: dec(x.content) })), null, 1));
    console.log('已落盘（已解码）：%s', OUT);
  }
  process.exit(allBad.length ? 3 : 0);
})();
