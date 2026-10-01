# 直连 /v2 接口（绕开浏览器）——签名算法与用法

> 2026-10-01 打通。**批量只读任务优先走这条**：不需要浏览器、不会被渲染进程拖死、
> 几百个请求几十秒跑完。写操作仍然走浏览器（或至少先确认接口语义）。

## 1. 为什么要绕过浏览器

agent-browser / CDP 在本机跑**批量整页导航**时很脆：几十次 `Page.navigate` 之后
渲染进程会被拖住，表现为 `cdp timeout Runtime.evaluate` / `Page.navigate`，
下载也不落地。模板下载这类"同一页面换个 id 反复访问"的任务尤其容易触发。

**结论：只要目标数据能通过 GET 接口拿到，就直接调接口。**

## 2. 接口要点

- 站点同源即可：`https://<站点域名>/v2/...`（例：`https://lyyz.fuulea.com/v2/tasks/`）。
  也有 `https://api.fuulea.com/v2/`，但用站点同源最省事。
- 每个请求要带三个头：

| 头 | 值 |
|---|---|
| `Authorization` | `jwt <localStorage.jwt-token>` |
| `uuid` | `localStorage.uuid`（形如 `v3_1687480797`） |
| `fl-sec-sign` | `<32位hex>,<unix秒>`，**每个请求都要重算**（含时间戳） |

- 另建议带 `Accept: application/json, text/plain, */*`、`X-Requested-With: XMLHttpRequest`。
- 少了 `fl-sec-sign` 会返回 `400 {"detail":"Auth Error. 1000"}`；
  少了 `Authorization` 返回 `401 {"detail":"身份认证信息未提供。"}`。

## 3. 签名算法（从前端 `main-*.js` 的 axios 拦截器还原）

```
key  = jwtSig[0:3] + jwtSig[8:10] + jwtSig[-5:]        # jwtSig = JWT 第三段（签名）
ts   = floor(Date.now()/1000)
path = URL.pathname，若不以 / 结尾则补一个 /
q    = params 里所有非空项 → "key小写=值"，按**原始 key** 排序后 "&" 连接
s    = `${METHOD} ${path}?${q}&none=${ts}&key=${key}&agent=${uuid}&uuid=${uuid}`
sign = murmurhash3_x64_128_hex(utf8(s))
header fl-sec-sign = `${sign},${ts}`
```

实现见 `scripts/murmur3.js`（纯 JS / BigInt，零依赖）。
**自检**（用 2026-10-01 的真实抓包向量）：

```bash
node scripts/api.js selftest     # 期望输出 SELFTEST OK
```

> hex 拼接顺序是 `h1高32 | h1低32 | h2高32 | h2低32`，对着真实输出校过，别凭直觉改。

## 4. 用法

```bash
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
SK=~/.workbuddy/skills/fuulea-teaching-cloud

# ① 从浏览器 localStorage 取一次凭据（需先登录；结果存 scripts/.api-creds.json，chmod 600）
bash $SK/scripts/login.sh lyyz
node $SK/scripts/api.js creds lyyz      # ⚠️ 必须带别名，见下

# ② 在脚本里用
#   const { Api, loadCreds } = require('<SK>/scripts/api.js');
#   const api = new Api(loadCreds());
#   const r = await api.get('/v2/tasks/', {...});     // → {status, json, text}
#   const buf = await api.getBinary('/v2/tasks/<id>/class-list/');  // 二进制（xlsx）
```

>`loadCreds()` 只读 `.api-creds.json`，**不会**去碰浏览器 —— 这正是批量任务要的。

## 5. 常用接口（本项目已验证）

| 用途 | 接口 |
|---|---|
| 我发布的 / 某学科的任务 | `GET /v2/tasks/?subjectId=<sid>&gradeId=<gid>&type=2&page=N` |
| 考试列表 | `GET /v2/exam/?role=grade&name=&page=N`（15 条/页） |
| 考试下的学科与班级 | `GET /v2/exam/<examId>/subjects/` → `data[].subject` / `data[].classrooms[]` |
| 教师信息（含所属学科、管理年级） | `GET /v2/auth/teachers/<teacherId>/` |
| **成绩上传模板（全通教育 班级对照表）** | `GET /v2/tasks/<taskId>/class-list/` → xlsx |
| **试卷库检索（考试范围卷）** | `GET /v2/papers/?kw=<关键词>&subjectId=<sid>&scope=exam&page=N&pageSize=N` |

### 试卷库 `/v2/papers/`（2026-10-01 解出参数）

参数结构从前端 `chunk-JQSFN3X7.js` 的 `fl-set-template` 组件（考试详情页「关联已有试卷」弹窗）解出：

```js
// 组件里：onPaperSearch(e){ this.searchPaperChange$.next({kw:e, subjectId:this.examSubject.subject.id, scope:"exam"}) }
// 服务里：getPaperLists(i){ return this.doGet("/papers/", i) }
```

- **`kw`** 模糊匹配卷名（跨校全平台可见，能搜到外校卷）。
- **`scope`** 取值：`exam`(考试卷) / `all` / `course` / `task` / `exercise` / `blackboard` / `tk` / `special`。
  课程侧「关联试卷」用 `scope:"course"`（见 `chunk-ZQ3Q7YRM.js`）。
- **`subjectId`** 必带。**不带任何参数会命中全库**（`count` 数十万，无意义）。
- ⚠️ 参数名**不是** `keyword` / `gradeId` —— 用错会 `500`（不是 400），别硬试。
- 已知同类接口：`GET /v2/papers/<paperId>/`（卷详情，可带 `taskId`）、`GET /v2/papers/<paperId>/coordinates/`。
- 封装脚本：`node $SK/scripts/lookup_papers.js <subjectId> "<考试名>"`，
  退出码 `0` = 精确同名命中 / `3` = 库中无此卷。
  **判读必须带对照**：先搜一份已知在库的卷确认检索能命中，再搜目标卷。

### 坑

- `/v2/tasks/` **默认按当前账号的学科收窄**（账号 `subject` 字段决定），
  不加 `subjectId` 只会看到自己那科的。要全学科就把 9 个 `subjectId` 轮一遍。
- `/v2/tasks/` 的 `publishStatus` / `teacherId` 参数实测**不改变结果**，别指望用它筛。
- 参数名不认识会直接 `400 {"detail":"无效的输入。"}`（如 `examId`、`classroomId` 都不吃）。
- 凭据里的 `jwt` 有有效期，过期后重新跑 `node scripts/api.js creds <别名>`。
- **`creds` 必须带站点别名**（如 `creds lyyz`）。不带时 `cdp-url` 会指到 agent-browser 的
  默认/上一次会话，那个会话多半是登出状态 → 读不到 `jwt-token`，并报出**指向错误方向**的
  「先确认已登录」（2026-10-01 实栽）。修复后失败信息会打印实际看到的 URL 与会话名。
- **取完凭据立刻停手，别反复整页导航**：约 3~9 次 `goto` 后渲染进程会被拖死，
  表现为 `cdp timeout Runtime.evaluate`。此时只能
  `bash $SK/scripts/browser.sh hard-reset` → 重新登录 → 再取一次（走通约十几秒）。

## 6. 成绩上传模板（全通教育）长什么样

`class-list` 每次返回同一个文件名的 xlsx（`班级对照表.xlsx`），两张表：

| 表 | 内容 |
|---|---|
| `小题分` | 表头样板：`姓名` + 题号列。**题号列数随"考试×学科"变化**（如地理 19～44 列） |
| `班级对照表` | `姓名 → 2024级X班-班级ID`，覆盖该考试该学科的全部班级 |

- 模板内容由 **(考试, 学科) 决定**，与该学科下具体是哪个班的任务无关；
  同组合内所有任务返回**完全相同**的内容。
- 不同考试即使同学科也不同（题号列数不同），**所以要一场一场下**。

批量下载：

```bash
node $SK/scripts/download_exam_templates.js 2434 /tmp/tpl --dedup
#  args: <gradeId> <outdir> [--dedup(每考试×学科一份) | --all(每任务一份)]
```
