# 班级任课教师补录 SOP（2026-09-30 首次跑通，lyyz 生产站）

> 适用：把「班级 → 科目 → 老师」名单补进系统。**老师账号已存在**（手机号 = 账号），
> 只是没挂到该班；**不涉及新建账号**。
> 脚本：`scripts/cdp/add_class_teachers.js`（写）+ `scripts/cdp/scan_class_teachers.js`（只读）。

---

## 1. 站点与页面事实

| 事实 | 值 |
|---|---|
| 入口 | 左侧头像菜单「我的班级」，或直连 `/classroom` |
| 列表结构 | 按年级分段：`2024级` / `2025级` / `2026级`，每段一张 `行政班` 表 |
| 列表列 | 编号 · 名称 · 类型 · 人数 · 允许加入 · 状态 · 创建时间 · 动作(解散 / 详情) |
| 详情路由 | `/classroom/<classId>` —— **classId ≠ 列表页「编号」** |
| 详情页结构 | 标题(班级名) + `解散` `修改班级信息` → **教师**区 → **学生**区 |
| 教师区控件 | `班主任`(nz-select) · `添加教师`(nz-select，可搜索) + `添加`按钮 |
| 教师卡片 | 圆形徽标 `师`/`主` + 姓名 + 学科（如 `高中语文`）；卡片可 ✕ 移除 |

**已知 classId 对照（2026-09-30 抓取，会变，用时重新抓）**

| 班级 | classId | 班级 | classId |
|---|---|---|---|
| 2024级9班 | 591219 | 2025级17班 | 591085 |
| 2024级10班 | 591220 | 2025级18班 | 591086 |
| 2024级18班 | 591221 | 2025级19班 | 591087 |
| 2024级19班 | 591222 | 2025级20班 | 591088 |
| 2026级18班 | 591002 | 2026级19班 | 591003 |
| 2026级20班 | 591004 | | |

## 2. 操作流程

```
① 只读摸底  scan_class_teachers.js  → 每班现有教师（姓名+学科）
② 与名单比对 → 生成 items.jsonl（只列"缺的"）+ 方案给用户确认（prod 必须）
③ 先跑 1 条  add_class_teachers.js --start N --limit 1
④ 放量        add_class_teachers.js（不带 limit）
⑤ 重扫复核  scan_class_teachers.js  → 与名单逐项比对 + 人数前后核对（副作用检查）
⑥ 出完成报告（含 before/after 文本与截图）
```

## 3. 页面内关键选择器

```js
// 三个 nz-select 的 search input，顺序固定
const inputs = [...document.querySelectorAll('input.ant-select-selection-search-input')];
// inputs[0]=班主任  inputs[1]=添加教师  inputs[2]=添加学生

// 「添加」按钮：在 添加教师 select 的同一父容器里
const grp = inputs[1].closest('.ant-select').parentElement;
const btn = [...grp.querySelectorAll('button')].find(b => b.innerText.trim() === '添加');

// 下拉候选项（浮层在 .cdk-overlay-container）
const opts = [...document.querySelectorAll(
  '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')]
  .map(o => o.innerText.trim());

// 教师区文本（用于 before/after 留证）
const m = document.body.innerText.match(/教师\n([\s\S]*?)\n学生/);
```

教师区文本的解析：`师`/`主` 行之后紧跟「姓名」「学科」两行。

## 4. 三个坑（都实际栽过）

### 坑 1 — 类型搜索必须用真实按键（最费时间的坑）
`Input.insertText` 或页面内 `dispatchEvent(new Event('input'))` 之后：
- input 的 value 有值、placeholder 消失 → **看起来输入成功了**
- 但下拉候选**恒为空** → 误判为"系统里没这个老师"

正解（CDP）：
```js
for (const ch of text) {
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown', text: ch, unmodifiedText: ch, key: ch,
    code: 'Digit' + ch, windowsVirtualKeyCode: ch.charCodeAt(0), nativeVirtualKeyCode: ch.charCodeAt(0),
  });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Digit' + ch,
    windowsVirtualKeyCode: ch.charCodeAt(0), nativeVirtualKeyCode: ch.charCodeAt(0) });
  await sleep(35);
}
```
清空输入用 `commands:['selectAll']` + Backspace（`el.value=''` 同样不触发搜索）。

### 坑 2 — classId ≠ 列表编号
列表页 `469474` → 详情页 `/classroom/591219`。**拿列表编号拼 URL 会打到别的班**。
抓法：在列表点「详情」，读 `location.pathname`。

### 坑 3 — 偶发「搜不到」（下拉未及时渲染）
同一批 10 条里可能偶发 1 条候选为空（不是账号不存在）。
护栏是「搜不到就不点添加」→ 该条标 failed，**整批结束后单独重跑这一条**即可成功。
不要因为它失败就去改搜索方式。

## 5. 脚本护栏一览（`add_class_teachers.js`）

| # | 护栏 |
|---|---|
| 1 | 生产站(prod) 无 `--yes` 直接拒绝执行（`--dry` 不受限），退出码 3 |
| 2 | 幂等：教师列表已有该姓名 → `skipped_already_present`，不重复添加 |
| 3 | 搜索候选里没有该手机号 → `failed_no_such_teacher`，**绝不点「添加」** |
| 4 | 点完「添加」必须轮询到教师列表出现该姓名，否则 `failed_not_applied` |
| 5 | 任一 failed/error → 退出码 1 |
| 6 | 每班落 `*-before.txt` / `*-after.txt`（教师区原文）+ `*-after.png` 截图 |
| 7 | `--limit` / `--start` 支持分批与试水 |

## 6. 名词澄清

- **「主」徽标 ≠ 班级的班主任字段**：教师卡片上的 `主` 是教师自身角色；
  班级级「班主任」是顶部那个独立下拉，常见空态「请选择班主任」。
  **加老师不会改班主任**，两者是两件事。
- **`--dry`** 只导航 + 读列表 + 打印将要做什么，不发任何写请求。
