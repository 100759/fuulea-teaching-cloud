# 学科阅卷生命周期：开始阅卷 → 结束阅卷 → 公布成绩（2026-10-01 全流程实测）

> 全站 17 场考试 / 153 个「考试 × 学科」格子实跑通过：104 格三步全绿、0 失败、逐格 diff 零意外。

## 一、状态位与 status 取值

前端枚举（`chunk-JQSFN3X7.js` 的 `ukt`，对应 `statusCode`）：

| 位 | 名称 | 含义 |
|---|---|---|
| 1 | `STATUS_HAS_TEMPLATE` | 有答题卡模板 |
| 2 | `STATUS_HAS_ANSWER` | 答案已设置 |
| 4 | `STATUS_HAS_SET_MARKING` | 已设阅卷分配 |
| 8 | `STATUS_MARKING` | 阅卷中 |
| 16 | `STATUS_MARKED` | 阅卷完成 |

后端 `status` 实测取值（与界面按钮 153/153 一致）：

| 值 | 含义 | 界面按钮 |
|---|---|---|
| `0` | 未绑定试卷 | 制作答题卡 · 关联已有试卷 · 发布(灰) · 阅卷分配(灰) · 开始阅卷(灰) |
| `11` | 已发布 · 考试阅卷 | … · 开始阅卷 |
| `15` | 已发布 · 任务阅卷 · **未开始阅卷** | … · 开始阅卷（有交卷可点，无交卷灰） |
| `47` | **已开始阅卷（未结束）** | … · **结束阅卷** |
| `111` | **已结束阅卷** | … · **重新阅卷** |

> `111` 不等于「公布过」。公布与否另看 `showAnswerAt`（见四）。

## 二、四个接口

| 动作 | 接口 | 成功判定 | 状态变化 |
|---|---|---|---|
| 开始阅卷 | `GET /v2/exam/subject/<esId>/mark/` | 200 + body `{}` | `15 → 47` |
| 结束阅卷 | `POST /v2/exam/subject/<esId>/finish/` | 200 + body `{"detail":null}` | `47 → 111` |
| 公布成绩 | `POST /v2/exam/<examId>/show-answer/` body `{examSubjectId, action:"show"}` | **HTTP 201** + 空 body | `showAnswerAt` → 当前时间 |
| 撤回成绩 | 同上，`action:"hide"` | — | `showAnswerAt` 回退 |

- 前端服务方法名：`examSrv.startSubjectMark / endSubjectMark / showAnswer(examId,'show'|'hide',examSubjectId)`。
- 注意 **公布成绩的 id 是 examId，考试学科 id 放 body**（路径里没有 esId），别拼错。
- 「结束阅卷」前置：`(status & 2) > 0`（答案已设置），否则前端直接报
  「尚未进行答案设置，不能结束阅卷，请通过"答案设置"，保存答案后再试」。`47 & 2 = 2`，满足。

## 三、「开始阅卷」能不能点 = 有没有交卷数据（不用开浏览器）

```
GET /v2/exam/subject/<esId>/scan/progress/
→ {"classroomPercent":[{"classroomId":591219,"classroomName":"2024级9班","sumCount":31,"submitCount":31,"percent":100}, …]}
```

任一班 `submitCount > 0` → 可点；全 0 → 灰。153/153 与浏览器逐行读出的按钮态完全一致。

## 四、「公布成绩」还是「撤回成绩」 = 看 `showAnswerAt`

`GET /v2/exam/<examId>/subjects/` 的 `data[].showAnswerAt`：

- **未来占位时间**（如 `2029-09-12T10:33:30+08:00`）= 未公布 → 按钮「公布成绩」
- **真实过去时间** = 已公布 → 按钮「撤回成绩」

前端 `disabledShowAnswer` 要求该科 `statusCode.has(STATUS_MARKED)`，实测即 `status === 111`。

## 五、批量脚本

```bash
SK=~/.workbuddy/skills/fuulea-teaching-cloud
node $SK/scripts/mark_plan.js  /tmp/plan.json                      # ① 只读：出「开始阅卷」可点清单（含完整性闸门）
node $SK/scripts/start_mark.js /tmp/plan.json /tmp/log1.jsonl --limit 2 --yes
node $SK/scripts/start_mark.js /tmp/plan.json /tmp/log1.jsonl --yes
node $SK/scripts/end_mark.js              --limit 2 --yes --log /tmp/log2.jsonl   # ② 结束阅卷（目标 = 当前 status 47）
node $SK/scripts/end_mark.js              --yes --log /tmp/log2.jsonl
node $SK/scripts/show_answer.js --action show --limit 2 --yes --log /tmp/log3.jsonl  # ③ 公布成绩
node $SK/scripts/show_answer.js --action show --yes --log /tmp/log3.jsonl
```

三个脚本的共性护栏：
- 目标由**当前真实状态**推导（`mark_plan` 用 `scan/progress`；`end_mark` 用 `status===47`；`show_answer` 用 `status===111` + `showAnswerAt` 方向），**不复用旧清单**。
- 每条执行前**重新读一次状态**，不满足就跳过 → **幂等**，重复跑不会重复操作。
- 生产站必须显式 `--yes`，否则只空跑；响应不符合成功判定即 fail 并**非 0 退出**。
- `--limit / --start / --only <examId:subject,…>` 支持分批与单点。

## 六、2026-10-01 执行记录

基线（19:34）：`15`=130 / `111`=20 / `0`=3。

| 阶段 | 执行 | 结果 | 变化 | 意外格 |
|---|---|---|---|---|
| 开始阅卷 | 104 条 | ok=104 fail=0 | 仅 `15→47` | 0 |
| 结束阅卷 | 104 条 | ok=104 fail=0 | 仅 `47→111` | 0 |
| 公布成绩 | 104 条 | ok=104 fail=0 | 仅 `showAnswerAt` 占位未来→当前 | 0 |

终态：`111 且已公布`=124（本次 104 + 平台原有 20）· `15`=26（无交卷，从未开始）· `0`=3（未绑卷）。
平台原有状态全程未被改动。

## 七、踩坑

- **`GET /v2/exam/subject/<esId>/mark/progress/` 的 `subjectMarkInfo` 是按学科聚合的**
  （拿语文的 esId 查，会同时列出化学），**不能用来判断单格状态**；判断一律用 `status`。
- **`GET /v2/exam/<examId>/subject/<esId>/paper/` 是 405**（该路径只支持 PUT/DELETE）；
  要读试卷信息用 `GET /v2/exam/<examId>/subjects/` 的 `data[].paper`。
- **`lyyz.fuulea.com` 的页面与静态资源需要浏览器 UA + Referer 才返回 200**，裸 `curl` 是 403；
  想读前端 bundle 就带上这两个头（chunk 都在站点根目录，如 `/chunk-JQSFN3X7.js`）。
- 详情页按钮**不在** `button` 选择器里全都能抓到（有的包在 `nz-dropdown` / 后面的容器）；
  读按钮态时取「包含『阅卷分配』的最外层行容器」再往下找，别只取紧邻的小 div。
