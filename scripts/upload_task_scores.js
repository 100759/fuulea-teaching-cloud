// 批量「导入成绩」（任务详情 → 导入成绩 → 选数据源 → 上传文件）
//
// 底层接口（2026-10-01 从前端 chunk-WKZ7B2ZD.js 逆出）：
//   POST /v2/tasks/import/data/   multipart/form-data
//     usernamePrefix = ""         （学生姓名前缀，留空）
//     source         = "qt"       （数据源：zhx=智学网 qt=全通教育 dameijia=达美嘉
//                                  haofenshu=好分数 haofenshuMiniTable=好分数-小分表）
//     taskId         = <taskId>
//     file           = <xlsx>
//   成功 → 响应体是 `{}`（空对象）；有错 → 响应体是非空对象（行/姓名 → 原因）。
//   导入是**后台异步**执行（页面提示「导入在后台进行!」），需另查 /v2/tasks/<id>/score/ 复核。
//
// ⚠️ 本操作会写入真实学生成绩（生产站不可轻率）。护栏：
//   1. 生产站必须显式 --yes（FUULEA_BASE 含 lyyz / 非 test 时判定为生产）
//   2. --dry 空跑：只打印将要做什么，不发请求
//   3. --start N / --limit N 分段放量
//   4. 幂等：log 里已 ok 的 taskId 直接跳过（重跑不会重复导入）
//   5. 逐条校验：文件存在 / 非空 / xlsx / taskId 为正整数；响应必须是 `{}`
//   6. 任一失败 → 非 0 退出；失败项单独列出，便于单条补跑
//
// 用法:
//   node upload_task_scores.js <items.jsonl> <log.jsonl> [--start 1] [--limit 0] [--dry] [--yes]
//                                [--source qt] [--shots <dir>]
//
// items.jsonl 每行至少: { exam, subject, file, taskId }
const fs = require('fs');
const path = require('path');
const { Api, loadCreds, BASE } = require('./api.js');
const { sleep } = require('./cdp/cdp.js');

const args = process.argv.slice(2);
const ITEMS = args[0], LOG = args[1];
if (!ITEMS || !LOG) {
  console.error('用法: node upload_task_scores.js <items.jsonl> <log.jsonl> [--start N] [--limit N] [--dry] [--yes] [--source qt]');
  process.exit(2);
}
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const START = Number(opt('--start', 1));
const LIMIT = Number(opt('--limit', 0));
const DRY = args.includes('--dry');
const YES = args.includes('--yes');
const SOURCE = opt('--source', 'qt');
const SHOTS = opt('--shots', '');

const isProd = !/test\.fuulea\.com/.test(BASE);
if (isProd && !YES && !DRY) {
  console.error('拒绝执行：目标是非测试站（' + BASE + '）。这是生产环境，加 --yes 明确授权。');
  process.exit(3);
}

const readJsonl = f => fs.existsSync(f)
  ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

(async () => {
  const items = readJsonl(ITEMS);
  const done = new Set(readJsonl(LOG).filter(r => r.ok).map(r => String(r.taskId)));
  const { jwt, uuid } = loadCreds();
  const api = new Api({ jwt, uuid });

  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const logFd = fs.openSync(LOG, 'a');

  let ok = 0, skip = 0, fail = 0, idx = 0;
  const failures = [];
  for (const it of items) {
    idx++;
    if (idx < START) continue;
    if (LIMIT && ok + skip + fail >= LIMIT) break;

    const taskId = String(it.taskId);
    const tag = '[' + idx + '/' + items.length + '] ' + it.exam + ' · ' + it.subject + ' (task ' + taskId + ')';

    if (done.has(taskId)) { skip++; console.log('SKIP  ' + tag + ' — 已在 log 中成功过'); continue; }

    // 前置校验
    if (!it.file || !fs.existsSync(it.file)) { fail++; failures.push([taskId, it.exam, it.subject, '文件不存在: ' + it.file]); console.log('FAIL  ' + tag + ' — 文件不存在'); continue; }
    const buf = fs.readFileSync(it.file);
    if (buf.length < 1000 || buf.slice(0, 2).toString('hex') !== '504b') { fail++; failures.push([taskId, it.exam, it.subject, '不是有效 xlsx (' + buf.length + 'B)']); console.log('FAIL  ' + tag + ' — 非 xlsx'); continue; }
    if (!/^\d+$/.test(taskId)) { fail++; failures.push([taskId, it.exam, it.subject, 'taskId 非法']); console.log('FAIL  ' + tag + ' — taskId 非法'); continue; }

    if (DRY) { console.log('DRY   ' + tag + ' — 将上传 ' + path.basename(it.file) + ' (' + buf.length + 'B, source=' + SOURCE + ')'); ok++; continue; }

    const rec = { at: new Date().toISOString(), taskId: it.taskId, exam: it.exam, subject: it.subject, file: it.file, bytes: buf.length, ok: false };
    try {
      const form = new FormData();
      form.append('usernamePrefix', '');
      form.append('source', SOURCE);
      form.append('taskId', taskId);
      form.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), path.basename(it.file));
      const r = await api.postForm('/v2/tasks/import/data/', form);
      if (r.status !== 200) throw new Error('HTTP ' + r.status + ' ' + String(r.text).slice(0, 200));
      const j = r.json;
      if (j === null) throw new Error('响应不是 JSON: ' + String(r.text).slice(0, 200));
      const keys = Object.keys(j);
      if (keys.length) {
        rec.errors = j;
        throw new Error('导入返回 ' + keys.length + ' 条问题: ' + JSON.stringify(j).slice(0, 300));
      }
      rec.ok = true; rec.resp = '{}';
      ok++;
      console.log('OK    ' + tag + ' — 已提交（后台导入）');
    } catch (e) {
      fail++; failures.push([taskId, it.exam, it.subject, e.message]);
      rec.err = e.message;
      console.log('FAIL  ' + tag + ' — ' + e.message);
    }
    fs.writeSync(logFd, JSON.stringify(rec) + '\n');
    await sleep(400);
  }
  fs.closeSync(logFd);

  console.log('\n结果: ok=' + ok + ' skip=' + skip + ' fail=' + fail + (DRY ? '  (DRY-RUN，未真的上传)' : ''));
  if (failures.length) {
    console.log('\n失败明细（补跑时用 --start 定位或单独重跑这些 taskId）：');
    for (const f of failures) console.log('  task ' + f[0] + ' | ' + f[1] + ' · ' + f[2] + ' | ' + f[3]);
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
