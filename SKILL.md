---
title: 智慧教学云（fuulea）站点操作自动化
summary: 用浏览器自动化驱动 https://test.fuulea.com 智慧教学云，完成登录、模块巡检、核心业务流程走查（布置作业/组卷/阅卷/学情/错题/考试/靶向/单词/技能控制台）与截图留证，产出可复核的操作报告
description: 当用户提到「智慧教学云」「辅立码课」「fuulea」「test.fuulea.com」「lyyz.fuulea.com」，或要求「登录这个站点看看」「走一遍布置作业/阅卷/组卷流程」「巡检各模块」「截个图看看XX页面」「验证一下XX功能」「检查页面有没有报错」「给考试关联已有试卷」「把试卷绑到考试上」「批量绑卷」「把所有绑了试卷的考试都发布出去」「发布考试任务」「阅卷分配」「设置任务阅卷」「给班级添加任课教师」「把老师挂到班上」「按名单补录班级教师」「下载成绩上传模版」「班级对照表」「全通教育导入模板」「批量下载考试模板」「直连接口取数据」「有哪些科目没绑定试卷」「哪些考试没发布」「哪些还没改成任务阅卷」「出考试配置缺口台账」「全站盘点考试配置」「查一下哪些考试科目配置不全」时使用。内含站点地图、角色权限、路由清单、核心业务流程、跨学科批量绑卷流水线、批量发布考试任务+任务阅卷流水线、班级任课教师批量补录（均为 CDP 驱动）、**直连 /v2 接口的签名算法与批量只读用法**，与实操踩坑要点。
agent_created: true
---

# 智慧教学云（fuulea）站点操作自动化

## 1. 站点是什么

- **产品**：智慧教学云 / 辅立码课平台，河北习知软件科技有限公司出品（冀ICP备16003367号）。版本形如 `26.9.7c`，控制台会打印「版本: xx」。
- **前端**：`https://test.fuulea.com/`（测试站）；**后端 API**：`https://api.fuulea.com/v2/`
- **技术栈**：Angular（standalone + NgModule 混合）+ ng-zorro-antd + TailwindCSS + G2Plot/D3；SPA，**无 SSR**。
- **登录方式**：微信扫码登录（默认）/ 账号登录（需点「账号登录」tab）。
- **多租户**：按域名区分学校站点（`site.name`），左侧 logo、菜单可见项随站点与角色变化。

> 完整路由地图见 `references/site-map.md`，业务流程见 `references/business-flows.md`，
> agent-browser 命令与坑见 `references/automation-playbook.md`，
> 站点家族与新增站点见 `references/site-family.md`，
> **直连 /v2 接口（签名算法 + 用法，批量只读任务首选）见 `references/api-direct.md`**，
> **跨学科批量「关联已有试卷」全流程 SOP 见 `references/bind-papers-workflow.md`**，
> **批量「发布考试学科任务 + 阅卷分配(任务阅卷)」SOP 见 `references/publish-exam-task-workflow.md`**
> （含 CDP 驱动方案 `scripts/cdp/`，用于绕开标签被冻结导致的 `about:blank`）。

## 2. 触发条件（满足任一即加载）

- 用户点名 **智慧教学云 / 辅立码课 / fuulea**，或给出站点域名：
  `test.fuulea.com`（测试站）/ `lyyz.fuulea.com`（龙岩一中生产站）/ 其他学校子域
- 要求 **登录某站点** 并查看、截图、巡检、验收、回归
- 要求 **走一遍某条业务流程**（创建课程、布置作业、组卷、阅卷、学情分析、错题重练、考试、靶向、单词任务、教辅录入、技能控制台）
- 要求 **核对页面文案/字段/按钮**、**检查页面报错**、**导出页面数据**

## 3. 输入 / 输出

**输入**
| 入参 | 说明 |
|---|---|
| **站点** | `test`（默认）/ `lyyz`（生产）/ 其他别名，见 `scripts/sites.conf`。**必须先确定是哪个站** |
| 任务类型 | 巡检 / 单页查看 / 流程走查 / 数据导出 / 报错检查 / 创建对象 |
| 目标模块或流程 | 如「题库」「创建课程」「考试阅卷」 |
| 凭据 | 从 `scripts/.credentials` 或环境变量取；没有就问用户 |
| 只读 or 可写 | **默认只读**。生产站写操作必须先说明影响面并取得同意 |

**输出**
- 操作报告（Markdown）：站点、等级、步骤、URL、关键字段、截图路径、异常
- 截图：`/tmp/fuulea/<别名>/shots/<slug>-<时间戳>.png`
- 如需留档：整页文本 `agent-browser read` 落 `/tmp/fuulea/<别名>/pages/<slug>.txt`

## 4. 使用步骤

### Step 0 — 环境与凭据

```bash
# 本机 Bash 默认 PATH 缺 /usr/bin，必须先导出
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
```

**先确认目标站点。** 用户没说就用 `test`；说了学校名字（如「龙岩一中」）就查
`scripts/sites.conf` 找对应别名。别名不存在时，照 `sites.conf` 的格式加一行即可
（前端构建一致的话路由与选择器可直接复用）。

凭据在 `scripts/.credentials`（`别名|账号|密码`，chmod 600）或环境变量
`FUULEA_ACCOUNT` / `FUULEA_PASSWORD`。**不要**把密码打印到对话里或写入交付文档。

### Step 1 — 登录

```bash
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
SK=~/.workbuddy/skills/fuulea-teaching-cloud
bash $SK/scripts/login.sh test     # 测试站
bash $SK/scripts/login.sh lyyz     # 龙岩一中生产站（只登录，不代表可写）
```

脚本流程：`open` 首页 → 点「账号登录」→ `fill` 账号/密码 → 点「登录」→ 等待落地。
若已有会话会直接复用（幂等）。

验活：页面出现左侧导航（课程/任务/考试/题库/靶向/学情）即为成功；
若仍停在登录页，用 `agent-browser console` 看报错并回报用户。

**生产站登录后第一件事**：明确告诉用户你在生产站，并确认本次只做什么。

### Step 2 — 定位目标页面

优先**直连路由**（SPA 路由可直接 `open`），比层层点击稳：

| 想去 | 直接打开 |
|---|---|
| 课程 | `/course` |
| 任务 | `/task` |
| 考试 | `/exam` |
| 题库 | `/tk` |
| 对人靶向 | `/target/for-student` |
| 对点靶向 | `/target/for-knowledge` |
| 年级学情 | `/analysis/grade/overview` |
| 学科学情 | `/analysis/grade/graph` |
| 班级学情 | `/analysis/class` |
| 班级管理 | `/classroom` |
| 错题本 | `/booklet` |
| 单词本 | `/vocabulary` |
| 技能控制台 | `/algo/skill` |
| 问卷调查 | `/student-survey/home` |
| 学情仪表板 | `/bo/dashboard` |
| 管理看板 | `/dashboard` |

### Step 3 — 采集内容

```bash
agent-browser read            # 整页可读文本（首选，比截图省 token）
agent-browser snapshot -i     # 可交互元素 + ref（要点击时用）
agent-browser screenshot /tmp/fuulea/shots/x.png   # 截图留证（位置参数，不要 --path）
agent-browser console         # 页面日志/报错
```

### Step 4 — 走流程

按 `references/business-flows.md` 的步骤推进。**每一个会产生数据的动作
（发布任务、删除、解散班级、结束阅卷、创建课程、关联试卷）执行前必须停下来问用户确认。**

### 批量绑卷：直接用流水线脚本，别手搓

「给考试的各学科关联已有试卷」已固化成**流水线**（只有 `bind` 会写，其余全只读）：

```bash
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
SK=~/.workbuddy/skills/fuulea-teaching-cloud
bash $SK/scripts/exam_papers.sh lyyz reset          # ⓪ 页面卡死时先重置会话（可选）
bash $SK/scripts/exam_papers.sh lyyz snapshot       # ① 基线：全站 考试×学科 绑卷矩阵
bash $SK/scripts/exam_papers.sh lyyz scan-courses   # ② 各学科课程的 章节->试卷编号（9 科）
bash $SK/scripts/exam_papers.sh lyyz plan           # ③ 配对 -> 提案 + 缺口报告（给用户看）
bash $SK/scripts/exam_papers.sh lyyz verify         # ④ 只读核对每个卷号的候选项卷名
bash $SK/scripts/exam_papers.sh lyyz bind --yes     # ⑤ 用户批准后执行（写操作）
bash $SK/scripts/exam_papers.sh lyyz audit          # ⑥ 重扫并逐格 diff 查副作用
bash $SK/scripts/exam_papers.sh lyyz status         # 看当前产物与扫描完整性
```

**歧义章节**（`plan` 推不出对应考试、列入 `plan_report.md` 第三节的那些）不要放宽正则去硬配，
而是人工推断后落成一份独立提案 JSON，用 `--from` 复用同一套只读复核 + 写护栏：

```bash
bash $SK/scripts/exam_papers.sh lyyz verify --from proposals_math_manual.json         # 只读核对
bash $SK/scripts/exam_papers.sh lyyz bind   --yes --from proposals_math_manual.json   # 批准后写
```

（推断步骤见 `references/bind-papers-workflow.md` §2「歧义章节的人工推断」。
2026-09-30 实测：数学 11 条歧义章节按此法全部唯一命中并绑定成功。）

**两条内置闸门，别绕过：**

- **扫描完整性闸门**：`scan-courses` 会先清掉上次的 `ch_*.jsonl`（防过期数据被当有效数据用），
  再逐科扫描并汇总成 `scan_summary.json`。只要有任何一科失败/不可靠，
  `plan` 与 `bind` **直接拒绝执行**（退出码 5）——因为半份数据照样能算出一份
  "看起来完全正常"的提案，只是静默少报。确要用残缺数据才加 `--allow-partial`。
- **会话健康闸门**：所有开页面动作走 `open_checked`（见 `scripts/browser.sh`），
  确认真的渲染出来、不是 `about:blank`；失败自动**硬重置会话**再重试。

单条绑定也可以用底层的 `scripts/bind_paper.sh`：

```bash
bash $SK/scripts/bind_paper.sh lyyz <考试ID> <学科> <试卷编号> --yes "<期望卷名关键词>"
```

试卷来源是各学科的汇总课程（`2024级<学科>考试汇总`，一个章节 = 一场考试），
courseId 登记在 `scripts/papers/subject-courses.conf`，换学校需重新登记。

> **完整 SOP、命名归一化规则、四道护栏、两个"整批错位却看起来正常"的坑、
> 以及浏览器会话坏掉的症状与处置，见 `references/bind-papers-workflow.md`。动手前务必先读。**

### 脚本一览

| 脚本 | 用途 | 会不会写 |
|---|---|---|
| `scripts/lint.sh` | **技能自检**：shell/node 语法 + 两类静默反模式（见下） | 否 |
| `scripts/browser.sh <子命令>` | **浏览器会话公共层**：`session` / `hard-reset` / `open-checked` | 否 |
| `scripts/api.js` | **直连 /v2 接口的客户端**（`creds <别名>` 取凭据 / `selftest` 自检签名） | 否 |
| `scripts/murmur3.js` | fl-sec-sign 用的 murmurhash3 x64 128（纯 JS） | 否 |
| `scripts/download_exam_templates.js <gradeId> <outdir> [--dedup]` | **批量下成绩上传模板**（全通教育 班级对照表） | 否 |
| `scripts/login.sh <别名>` | 幂等登录 | 否 |
| `scripts/smoke.sh <别名> [过滤] [--yes]` | 全模块巡检出报告 | 否 |
| `scripts/exam_papers.sh <别名> <子命令> [--from <提案JSON>]` | **绑卷流水线总入口**（见上，含 `reset`；`--from` 可换提案文件） | 仅 `bind` |
| `scripts/bind_paper.sh <别名> <考试ID> <学科> <卷号> [--yes] [期望卷名]` | 单条绑定 | **是** |
| `scripts/papers/ab.js` | JS 驱动公共层（`openChecked` / `poll` / `ev`） | 否 |
| `scripts/papers/scan_matrix.js` | 抓 考试×学科 绑卷矩阵 | 否 |
| `scripts/papers/scan_course.js <courseId> <out>` | 抓 章节->试卷编号（+ `.meta.json`） | 否 |
| `scripts/papers/plan_bindings.py <workdir> [--allow-partial]` | 配对生成提案+缺口报告（含完整性闸门） | 否 |
| `scripts/papers/verify_bindings.js` | 核对候选项卷名 | 否 |
| `scripts/papers/diff_bindings.py` | 前后矩阵 diff | 否 |
| `scripts/scan_exam_cells.js <out.jsonl> [--exams ..] [--pages N] [--allow-partial]` | **全站 考试×学科 格子普查**（试卷/发布/状态/阅卷模式，直连接口，含完整性闸门） | 否 |
| `scripts/gap_report.py <cells.jsonl> <out.md> [out.xlsx]` | 由普查结果出「三类缺口台账」（未绑定 / 已绑未发布 / 仍是考试阅卷） | 否 |
| `scripts/audit_bind_all.js [out.json]` | **只读**：全站绑卷一致性核查（考试学期/年级 vs 所绑卷名，抓"绑错卷"；退出码 5 = 有可疑格）。发现可疑后**先判责、先问用户**，见 `references/bind-papers-workflow.md` §10 | 否 |
| `scripts/api.js creds\|selftest` / `scripts/murmur3.js` | /v2 直连客户端（fl-sec-sign 签名复刻） | 否 |
| `scripts/upload_task_scores.js <items.jsonl> <log.jsonl> [--dry] [--yes] [--source qt]` | **批量「导入成绩」**（后台异步；结果看左下角消息） | **是** |
| `scripts/mark_plan.js <out.json> [--allow-partial]` | **只读**：全站扫「开始阅卷」可点性（按 `scan/progress` 的 `submitCount`，无需浏览器） | 否 |
| `scripts/start_mark.js <plan.json> <log.jsonl> [--dry] [--yes] [--limit N] [--start N]` | **批量点「开始阅卷」**（`GET /exam/subject/<esId>/mark/`；每条执行前重读 status，幂等） | **是** |
| `scripts/end_mark.js [--dry] [--yes] [--limit N] [--start N] [--only …] [--log f]` | **批量「结束阅卷」**（`POST /exam/subject/<esId>/finish/`；目标=当前 status 47，每条复核，幂等） | **是** |
| `scripts/show_answer.js [--action show\|hide] [--dry] [--yes] [--limit N] [--only …] [--log f]` | **批量「公布成绩／撤回成绩」**（`POST /exam/<examId>/show-answer/`；目标=status 111 且 `showAnswerAt` 方向匹配） | **是** |
| `scripts/lookup_papers.js <subjectId> "<考试名>" [--pages N] [--json]` | **只读**：全平台试卷库检索（`GET /v2/papers/?kw=&subjectId=&scope=exam`）。退出码 3 = 库中无精确同名卷 | 否 |

### ⚠️ 「导入成绩」的真实语义（2026-10-01 实测，务必先读）

**`POST /v2/tasks/import/data/`（source=qt）实测只把「学生名单」写进任务，不写分数** ——
导入前后 323 个任务逐格 diff 零变化。**成功的判据看左下角消息**：
`GET /v2/inbox/trainer/`（page 走 params）→ `{"success":{"<文件名>":"导入学生: N"}}`（文案不含分数）。
站内「分数」的来源是**答题卡**（`score` 里 `hasPhoto=true` + 照片 URL）；全站有分数的任务极少。
排查细节、已排除因素、核对脚本、替代入口 → **`references/import-scores-semantics.md`**。

- **收下条件（2026-10-02 已验证，可当判据用）**：模板 `小题分` 表**题号格有任何空格 → 整份拒收**
  （`success:{}` + `分数格式错误[行,列]`，一名学生都不导入）。反之「空格 = 0」就必被收下，
  回执人数与文件行数逐一相等。
- **幂等陷阱**：`upload_task_scores.js` 只按 log 里 `ok:true` 跳过，而 `ok:true` = 接口返回 `{}`（已提交），
  **不等于平台收下了** ⇒ 重传「曾被拒」的任务**必须换新的 log 文件**，否则静默 SKIP 且日志仍报 `fail=0`。

### 批量只读任务：优先直连 /v2 接口（省事、稳）

**只要能 GET 到数据，就别用浏览器。** 详见 `references/api-direct.md`；一句话版：

```bash
SK=~/.workbuddy/skills/fuulea-teaching-cloud
bash $SK/scripts/login.sh lyyz        # 先登录
node $SK/scripts/api.js creds lyyz    # 从 localStorage 取 jwt/uuid 缓存到 .api-creds.json
                                      # ⚠️ 别名必须带：不带会连到别的会话 → 读不到 token
                                      #    并报误导性的「先确认已登录」
node $SK/scripts/api.js selftest      # 签名自检（应输出 SELFTEST OK）
node $SK/scripts/download_exam_templates.js 2434 /tmp/tpl --dedup
```

`/v2/tasks/` 默认**只返回当前账号所属学科**的任务，要全学科就把
`subjectId` 逐个轮一遍（学科 id 从 `/v2/exam/<id>/subjects/` 取）。

> ⚠️ **签名是 `murmurhash3_x64_128`，不是 md5。** 别看到 `<32位hex>,<时间戳>` 就去猜
> `md5(token+ts)` 之类的组合 —— 实测把 URL/token/ts/uuid 的全排列 ×10 种分隔符
> （64 万种组合）跑完，零命中。直接读 `scripts/murmur3.js` 的实现。

#### 考试配置类只读任务的黄金接口（2026-10-01 打通，秒级跑完全站）

| 要什么 | 接口 | 一次能给 |
|---|---|---|
| 考试清单 | `GET /v2/exam/?role=grade&name=&page=N` | `id / name / gradeName`，实测 `count=17` |
| 某场考试的 9 个学科 | `GET /v2/exam/<考试ID>/subjects/` | 每科 `paper{id,name,score}` / `publishedAt` / `endAt` / `status` / `classroomNames[]` / `studentCount` / `markPercent` |
| **某科阅卷分配模式** | `GET /v2/exam/subject/<examSubjectId>/marker/` | `markByTask`（true=任务阅卷 / false=考试阅卷）、`markType`、阅卷教师 |

`subjects` 接口 **不带 auth 头也能 200**（实测 `credentials:'omit'` 同样返回），
但 `marker` 接口**必须**带签名头。

**`status` 语义**（2026-10-01 全站 153 格实测，与界面读数 100% 一致）：

| status | 含义 | 对应的阅卷分配 |
|---|---|---|
| `0` | 未绑定试卷 | 无试卷 |
| `11` | 已发布 | 考试阅卷 |
| `15` | 已发布 | 任务阅卷（**未开始阅卷**） |
| `47` | 已发布 **已开始阅卷（未结束）** | 任务阅卷（界面按钮为「结束阅卷」） |
| `111` | 已发布 **且已结束阅卷** | 任务阅卷（界面按钮为「重新阅卷」，「阅卷分配」被禁用） |

> `111` 只代表**阅卷结束**，不代表公布过 —— 公布与否另看该科 `showAnswerAt`。

### 开始阅卷 → 结束阅卷 → 公布成绩（完整生命周期）

| 动作 | 接口 | 成功判定 | 状态变化 |
|---|---|---|---|
| 开始阅卷 | `GET /v2/exam/subject/<esId>/mark/` | 200 + `{}` | `15 → 47` |
| 结束阅卷 | `POST /v2/exam/subject/<esId>/finish/` | 200 + `{"detail":null}` | `47 → 111` |
| 公布成绩 | `POST /v2/exam/<examId>/show-answer/` body `{examSubjectId, action:"show"}` | **201** + 空 body | `showAnswerAt` → 当前时间 |

两个**不用开浏览器**的判据：

1. **「开始阅卷」能不能点** = 有没有交卷数据：`GET /v2/exam/subject/<esId>/scan/progress/`
   里任一班 `submitCount > 0`（153/153 与界面一致）。
2. **按钮是「公布成绩」还是「撤回成绩」** = 该科 `showAnswerAt`：未来占位时间（`2029-09-12…`）＝未公布；
   真实过去时间＝已公布。

```bash
SK=~/.workbuddy/skills/fuulea-teaching-cloud
node $SK/scripts/mark_plan.js   /tmp/plan.json                                    # ① 只读出可点清单（含完整性闸门）
node $SK/scripts/start_mark.js  /tmp/plan.json /tmp/log1.jsonl --limit 2 --yes
node $SK/scripts/start_mark.js  /tmp/plan.json /tmp/log1.jsonl --yes              # 幂等：非 15 自动跳过
node $SK/scripts/end_mark.js                 --limit 2 --yes --log /tmp/log2.jsonl  # ② 结束阅卷（目标=status 47）
node $SK/scripts/end_mark.js                 --yes --log /tmp/log2.jsonl
node $SK/scripts/show_answer.js --action show --limit 2 --yes --log /tmp/log3.jsonl # ③ 公布成绩
node $SK/scripts/show_answer.js --action show --yes --log /tmp/log3.jsonl
```

状态位、接口细节、2026-10-01 全站执行记录与踩坑 → **`references/mark-lifecycle.md`**。

> 想一次拿齐「未绑定 / 已绑未发布 / 阅卷模式」三类缺口，直接用：

```bash
node $SK/scripts/scan_exam_cells.js /tmp/fuulea/cells.jsonl     # 约 30 秒跑完 153 格
python3 $SK/scripts/gap_report.py /tmp/fuulea/cells.jsonl /tmp/缺口台账.md /tmp/缺口台账.xlsx
```

`scan_exam_cells.js` 带**完整性闸门**：有任何一格没取到就写 `<out>.summary.json`
并 `exit 5`，除非显式 `--allow-partial`。别拿半份数据生成"看起来正常"的报告。

#### ⚠️ 阅卷分配页（distribute）的三个坑（2026-10-01 实测）

1. **深链会被踢到登录页并清掉 token**：直接 `goto /exam/<id>/offline/distribute/<id>/teachers?...`
   → 跳到 `/?next=...`，且 `localStorage['jwt-token']` 被清空，后续所有请求 401。
   **分配页只能从考试详情页点「阅卷分配」按钮进去。**
2. **`history.pushState` + `popstate` 不会触发 Angular 路由**：URL 变了、但组件**没有**重新渲染，
   此时读 DOM 拿到的是**上一格的陈旧值** —— 这是比"读不到"危险得多的**假读数**
   （实测：pushState 到化学的 URL 后，标题仍是「阅卷分配-数学」、单选仍是数学的值）。
   **读之前必须校验页面标题 `阅卷分配-<学科>` 与目标学科一致，否则读数作废。**
3. **被禁用的「阅卷分配」按钮可以放行**：对 `status=111` 的格子，
   按钮 `disabled=true`，但 `removeAttribute('disabled')` 后再 `click()` 能正常进入分配页，
   用于读取被锁格的模式（纯只读；**千万不要碰页面的「保存」按钮**）。

参考实现见 `scripts/cdp/scan_marking_mode.js`（界面读法）与 `scripts/scan_exam_cells.js`（接口读法，优先）。


### 发布任务 / 阅卷分配：用 `scripts/cdp/`（CDP 驱动）

**批量发布考试学科任务 + 设「任务阅卷」时优先走这条**（agent-browser CLI 在生产站
长时间操作会被 Chrome 冻结标签，表现为 `get url` 恒为 `about:blank`）：

| 脚本 | 用途 | 会不会写 |
|---|---|---|
| `scripts/cdp/scan_publish_state.js <out.jsonl> [考试ID,…]` | 全站 考试×学科「绑卷+发布」状态（含量 `classCount`） | 否 |
| `scripts/cdp/pending_items.py <scan.jsonl> <items.jsonl> [--exams ..] [--subjects ..]` | 从扫描结果生成**待发布清单**并统计 | 否 |
| `scripts/cdp/diff_publish_state.py <before> <after> <items> [--expect-time ".."]` | 发布前后**逐格 diff**（新增==清单、无取消发布、无换卷、时间校验） | 否 |
| `scripts/cdp/publish_exam_task.js <items.jsonl> <out.jsonl> [--config cfg.json] [--limit N] [--start N] [--dry]` | 批量发布（护栏 1–5；失败退出码 1） | **是** |
| `scripts/cdp/assign_task_marking.js <items.jsonl> <out.jsonl> [--shots <dir>] [--limit N] [--start N] [--dry]` | 批量设「任务阅卷」（**不可逆**，保存后重载复核） | **是** |
| `scripts/cdp/scan_marking_mode.js <items.jsonl> <out.jsonl> [start] [limit]` | 只读：扫各格「阅卷分配」模式（**含 AntD 默认值假阴性防护**，见下 ⚠️） | 否 |
| `scripts/cdp/diff_marking_mode.py <before> <after> [--expect 任务阅卷] [--expect-count N]` | 阅卷分配模式 before/after **逐条** diff（查回退、查读取异常） | 否 |
| `scripts/cdp/add_class_teachers.js <items.jsonl> <out.jsonl> [--shots <dir>] [--limit N] [--start N] [--dry] [--yes]` | 批量给班级**添加任课教师**（按手机号搜 → 选中 → 添加；护栏见 §4.5） | **是** |
| `scripts/cdp/scan_class_teachers.js <classes.jsonl> <out.jsonl>` | 只读：扫各班级「教师」区 → `班级 -> [{role,name,subject}]` | 否 |
| `scripts/cdp/{cdp,login,session,boot}.js` | CDP 底座（自愈会话 / 幂等登录；站点由 `FUULEA_BASE` 决定） | 否 |

`publish_exam_task.js` 的默认参数（可被 `--config` 覆盖）：
`publishedAt=2026-09-28 17:00`、`endAt=2026-09-28 18:00`、
`classes=[2024级9/10/18/19班]`、`shotsDir=/tmp/fuulea/publish-shots`。

```bash
node scripts/cdp/publish_exam_task.js items.jsonl out.jsonl --limit 1 --dry   # 先空跑
node scripts/cdp/publish_exam_task.js items.jsonl out.jsonl --start 1         # 再放量
```

完整 SOP、行状态判据、「管理的班级」坑、日期控件填法见
`references/publish-exam-task-workflow.md`。

### ⚠️ 复核「阅卷分配」时最危险的一个假阴性（2026-10-01 实测）

**AntD 的 `nz-radio-group` 会先用默认值（`考试阅卷`）渲染，再用异步请求回填真实值。**
页面一渲染出 radio 就读 → 读到的是**默认值**。

实测后果：43 条「考试阅卷 → 任务阅卷」全部改成功（逐条保存后重载复核都是 `任务阅卷`），
但独立复核脚本"读一次就返回"，报出 **43 条仍是考试阅卷**。差一点就据此认为写操作没生效，
进而**重复操作一个不可逆的设置**。

规矩：

1. 读这类 radio/select 的"当前值"必须**连续两次读数一致**才认账
   （`scan_marking_mode.js` 已内建）；判不准就用「读 4 次 + 看是否稳定」的严格读法。
2. 旁证（不作判据）：切成任务阅卷后，distribute 页 URL 的 `examStatus` 由 `11` 变 `15`。
3. 复核用 `diff_marking_mode.py` **逐条对账**，它会把"读取失败/状态未知"单独列出来，
   不让你糊里糊涂地"看几条没问题就算过"。
4. **（2026-10-01 新增，最优解）能走接口就别读界面**：
   `GET /v2/exam/subject/<examSubjectId>/marker/` 的 `markByTask` 是权威值，
   **没有渲染竞态**。全站 153 格实测 **约 30 秒跑完、0 失败**（`scripts/scan_exam_cells.js`），
   而同一件事用界面点读要 40+ 分钟且频繁假阴性/看门狗超时。
   界面读法只在"要给用户看截图"时才用，且必须「接口 + 界面」双向一致才认账。
   实测这轮界面读法又假报了一次（29192 化学 首读「考试阅卷」，接口与重读都是「任务阅卷」）。
5. **`任务阅卷未被选中` 是"安全失败"，别重跑整批**（2026-10-01 实测）：
   该错抛在**点保存之前**（`if (!taskChecked(radioAfter)) throw`），
   所以**系统里没有产生任何写入** —— 那次 29191 语文 报错后，重扫确认它仍是「考试阅卷」。
   处置：**先全站重扫看真实状态**（确认只有它没生效），再**单独补跑这一条**，一次成功。
   直接重跑整批 = 对已经改好的不可逆格子再点一次，得不偿失。

#### 任务阅卷改造的标准动作（2026-10-01 定稿，40 条一次通过）

```bash
SK=~/.workbuddy/skills/fuulea-teaching-cloud
bash $SK/scripts/login.sh lyyz
node /tmp/get_creds.js                              # 取 jwt/uuid（= api.js creds）
node $SK/scripts/scan_exam_cells.js before.jsonl    # ① 动手前重扫（绝不复用旧清单）
# 从 before.jsonl 筛出 markByTask=false → items.jsonl，并断言全部 status=11
node $SK/scripts/cdp/assign_task_marking.js items.jsonl dry.jsonl  --dry --limit 1   # ② 空跑
node $SK/scripts/cdp/assign_task_marking.js items.jsonl log.jsonl  --limit 2         # ③ 真跑 2 条
node $SK/scripts/scan_exam_cells.js mid.jsonl       # ④ 接口验证这 2 条已生效
node $SK/scripts/cdp/assign_task_marking.js items.jsonl log.jsonl --start 2 --shots <证据目录>  # ⑤ 放量
node $SK/scripts/scan_exam_cells.js after.jsonl     # ⑥ 改后重扫
python3 .../diff                                  # ⑦ 断言「变化 ⊆ 目标」且试卷/发布状态零变化
```

```bash
node $SK/scripts/cdp/scan_marking_mode.js items.jsonl before.jsonl            # 改前基线
node $SK/scripts/cdp/assign_task_marking.js items.jsonl out.jsonl             # 改（不可逆）
node $SK/scripts/cdp/scan_marking_mode.js items.jsonl after.jsonl             # 改后复核
python3 $SK/scripts/cdp/diff_marking_mode.py before.jsonl after.jsonl \
        --expect 任务阅卷 --expect-count 43
```

#### ⚠️ 发布类操作四条反直觉点（2026-09-29 复盘 + 09-30 补）

1. **发布后班级会被服务端收窄**：抽屉里可选「管理的班级」11 个班、勾 4 个、页面显示
   「已选: 4 个班级」，但发布后行内往往只剩 2–3 个班 —— 平台按**学科有效班**收窄
   （地理恒 2、化学恒 3、历史 1，与其它场次一致）。**别把它当失败重发**。
2. **别用"班级数 == 目标数"做复核判据**（会 100% 误报）。只断言
   ① 行内出现班级名 ② 时间串精确相等。
3. **行内班级列表 ≥3 个时只显示前 2 个**，形如 `2024级10班、2024级19班等3个班级`
   —— 数班级名会把 3/4 个班误读成 2 个，要解析 `等(\d+)个班级`。
4. **`行读取失败 no-label` 是渲染竞态，不是数据问题**（2026-09-30 实测）：刚打开
   `/exam/<id>/detail` 时「学科列表」可能还在转圈，读行必然落空。两个 CDP 写脚本
   （`publish_exam_task.js` / `assign_task_marking.js`）已内建重试（≤4 次，第 2 次起重新
   goto）。看到 `-ERROR.png` 里是 `添加科目` 转圈就能确诊，**别去查卷号**。

**批量写操作的正确姿势**（本项目已验证有效；绑卷场景已实现为 `scripts/exam_papers.sh`）：
1. 先只读摸清全貌（有哪些对象、现状如何、目标值是什么），列成清单给用户看
2. 用户批准范围（可先做 1 场试水）
3. 把操作固化成脚本（带护栏：prod 需 `--yes`、幂等跳过、关键字段校验、自动截图）
4. 脚本跑完后**重新加载页面逐条复核**，并与操作前基线对比，确认没有误伤其他对象
5. 出完成报告（做了什么、结果、副作用检查、证据、遗留项）


### 4.5 班级任课教师补录：`scripts/cdp/add_class_teachers.js`

**场景**：把「班级 → 科目 → 老师」名单补进系统（老师账号已存在，只是没挂到该班）。

```bash
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
SK=~/.workbuddy/skills/fuulea-teaching-cloud
export FUULEA_BASE="https://lyyz.fuulea.com"; export FUULEA_ALIAS="lyyz"

node $SK/scripts/cdp/scan_class_teachers.js classes.jsonl after.jsonl        # ① 只读摸底
node $SK/scripts/cdp/add_class_teachers.js items.jsonl out.jsonl --start 1 --limit 1 --yes   # ② 先试 1 条
node $SK/scripts/cdp/add_class_teachers.js items.jsonl out.jsonl --yes        # ③ 放量
node $SK/scripts/cdp/scan_class_teachers.js classes.jsonl after2.jsonl        # ④ 重扫复核
```

- `items.jsonl` 每行：`{"class":"2024级9班","classId":"591219","subject":"数学","teacher":"张老师","phone":"13800000000"}`
- **`classId` 不是列表页的「编号」**！列表页编号（如 469474）≠ 详情路由 id（如 591219）。
  详情 id 要从列表点「详情」后读 `location.pathname` 拿，别拿编号去拼 URL。
- **UI 路径**：`我的班级/班级管理` → 行内「详情」→ 教师区三个 nz-select 依次是
  `[0]班主任 / [1]添加教师 / [2]添加学生`；在 `[1]` 里粘手机号 → 选下拉项 → 点「添加」。
- **手机号 = 账号**，能搜到说明老师在系统里；搜不到（下拉空/「无法找到」）说明没这个账号。
- **可逆**：教师卡片可单独 ✕ 移除。**加老师 ≠ 设班主任**（班主任是独立下拉，本次不动）。
- 脚本护栏：prod 无 `--yes` 拒绝执行 / 幂等跳过已存在 / **搜不到手机号绝不点「添加」** /
  点完必须等教师列表出现该姓名 / 任一失败退出码 1 / 自动落 before-after 文本 + 截图。
- 详细 SOP 与踩坑见 `references/add-class-teachers-workflow.md`。

### Step 5 — 收尾

```bash
agent-browser close                              # 关掉当前会话
bash $SK/scripts/browser.sh hard-reset           # 页面/登录异常时彻底重置本会话
bash $SK/scripts/browser.sh hard-reset --all     # 连别的会话一起清（谨慎）
```

## 5. 硬规则（踩过坑，别违反）

1. **PATH 必须导出**，否则 `ls`/`curl`/`python3` 全部 `command not found`。
2. **curl 直连会 403**（nginx 挡默认 UA）——要抓静态资源必须带浏览器 UA：
   `curl -A "Mozilla/5.0 (Macintosh; ...) Chrome/126.0 ..." ...`
3. **SPA 别用 `wait --load networkidle`**，会卡死。用 `sleep 3~6` + `snapshot`。
4. **`snapshot -i` 的 ref 会失效**，页面重渲染后要重新取。
   `click` 用 `@eN` 语法（`[ref=eN]` 会报 Element not found）。
5. **点击要打到真正的 `<button>`**：很多入口是 `<span>` 包 `<button>`，
   直接 `.click()` 外层 span 不触发 Angular。稳妥写法：
   ```js
   [...document.querySelectorAll('span')].find(x=>x.textContent.trim()==='加入选题'&&x.offsetParent)
     ?.closest('button')?.click()
   ```
6. **语义定位器 `text=xxx` 经常找不到**（Angular 注释节点干扰）。
   找不到就用 `agent-browser eval` 遍历 DOM 手动点。
7. **列表页的操作按钮常开弹层**（如考试成绩分析 → `.ant-modal`）而非跳路由；
   点完先查 `.ant-modal` / `.cdk-overlay-container` 再看 `get url`。
8. **题目篮**：加入题目后右下角出现 `.fixed-basket`（角标 = 已选题数）；
   发布任务路由 `/exercise/publish/task` 下会隐藏。清空用篮内「清空」。
9. **截图后不要假设能看图**——需要内容一律用 `read` / `eval innerText`。
10. **浏览器必须用命名会话**：`export AGENT_BROWSER_SESSION="fuulea-<别名>"`（`scripts/browser.sh` 已封装）。
    默认会话 `default` 是**全机共享**的，会被别的 agent 抢走页面。
11. **`open` 回 ✓ 不代表打开成功。** 必须用 `get url` + body 非空确认真的渲染出来了
    （`open_checked` 已封装）。`get url` 返回 `about:blank` 而 `console` 却有目标站日志，
    说明**会话状态文件坏了** —— `close --all` 清不掉它，要跑
    `bash scripts/browser.sh hard-reset`（关会话 + 杀守护进程 + 删状态文件）。
    同一会话名反复重试只会一直命中坏状态，别白费力气。
12. **收尾必须关会话**：`agent-browser close`（或 `bash scripts/browser.sh hard-reset`）。
13. **JS 模板字符串里写正则要 `\\d` 不写 `\d`**：`\d` 会被模板串吃掉变成 `d`，
    页面侧匹配全部返回 `null`（表现为"明明有元素却读不到"），排查极费时间。
14. **CDP 连接后必须 `Page.setWebLifecycleState({state:'active'})`**，
    否则生产站标签会被 Chrome 冻结/丢弃，`eval` 卡死、URL 变 `about:blank`；
    长时间批量操作**不要**用 `close --all`，会把登录态一起清掉。
15. **`$VAR` 后面紧跟全角字符也会报 `unbound variable`**（如 `$eid【` 被当成变量名）。
    配合 `set -u` 会让整批任务**在第一条就静默死掉**（2026-09-30 `bind` 实际栽在这上面，
    一次 39 条全没执行）。一律写 `${VAR}`。
16. **改完脚本、跑写操作之前先跑 `bash scripts/lint.sh`**：它专抓第 13、15 这两类
    "不报错、不崩、只静默出错"的问题（语法也一起查）。已用样本自测过能命中。
17. **截图留证前先把目标元素 `scrollIntoView({block:'center'})`**：
    长列表页（考试详情学科行、课程章节）里靠后的元素在折叠线以下，
    直接截图只拍到视口顶部 → **before/after 两张图逐字节相同，留证失真**。
    同时落一份**文本证据**（`innerText` 片段）——文本不受取景影响，才是精确证据。
    2026-09-30 绑卷 39 条里有 26 条栽在这上面。
18. **nz-select 的类型搜索只吃「真实按键」**：`Input.insertText` 和页面内
    `dispatchEvent(new Event('input'))` 都能把字写进框里（placeholder 消失、value 有值），
    但**下拉候选恒为空** —— 看起来像"系统里没这个老师"。必须用 CDP
    `Input.dispatchKeyEvent`（keyDown 带 `text` + keyUp）逐字符输入，或 agent-browser 的
    `type` 命令。2026-09-30 补录班级教师时栽过一次。
19. **班级详情路由 id ≠ 班级管理列表页的「编号」**：列表显示 `469474` 的班，详情页是
    `/classroom/591219`。要把 id 抓准，只能点「详情」后读 `location.pathname`，
    拿列表编号拼 URL 会打到别的对象上。
20. **"读不到元素"先怀疑渲染竞态，别先怀疑数据**：`/exam/<id>/detail` 打开后「学科列表」
    可能还在转圈，此时读行得到 `no-label`。凡是 `goto` 之后立刻读 DOM 的步骤，
    都要自带「短重试 + 失败截图」，并把重试做成脚本机制（第 13、15 条同理：
    能固化成闸门/重试的坑，不要留在人的记忆里）。
21. **批量只读任务优先直连 `/v2` 接口，别用浏览器硬跑**（见 `references/api-direct.md`）。
    浏览器在本机跑几十次 `Page.navigate` 后渲染进程会被拖住，表现为
    `cdp timeout Runtime.evaluate` / `Page.navigate`，连"点下载按钮"都不再落盘。
    能 GET 到的数据（任务列表、考试/学科/班级、成绩上传模板……）一律走接口。
22. **`Page.on()` 的监听器必须摘掉**（`cdp.js` 的 `goto` 里已修）：以前每次 `goto`
    都往 `listeners` 里塞一个 load 回调却从不移除，开着 `Network.enable` 时
    每个 CDP 事件都要跑 N 个回调 → Node 侧被拖死。`cdp.js` 里 `events` 缓冲区也已封顶。
    **改 `cdp.js` 后一定要 `node scripts/api.js selftest` + `bash scripts/lint.sh` 复验。**
23. **不要用 `history.pushState` + `popstate` 去"省一次整页刷新"**：Angular 路由
    对**同一个组件的纯 query 变化**往往不重渲染，页面还显示上一个对象的内容，
    脚本却以为切过去了 → **静默下错文件**。要么整页 `goto`，要么用接口。
    判断依据：切完 `document.body.innerText` 里仍是上一个对象的标题。
24. **读表单控件的"当前值"必须防默认值假象**：AntD 的 radio/select 会**先渲染默认值再异步回填**，
    读一次拿到的很可能是默认值（如阅卷分配恒读到「考试阅卷」）。**连续两次读数一致才算数**。
    这类假阴性会让你误判"写操作没生效"，进而重复执行**不可逆**操作——比漏改危险得多。
    **最优解是根本别读界面**：`GET /v2/exam/subject/<examSubjectId>/marker/` 的 `markByTask`
    是权威值、无竞态，全站 153 格 30 秒跑完（`scripts/scan_exam_cells.js`）。
25. **深链进 `offline/distribute/...` 会被踢到登录页并清空 `jwt-token`**（2026-10-01 实测）。
    表现为 URL 变成 `/?next=...`，且从此所有 `/v2` 请求 401（连别的页面也一起废掉）。
    阅卷分配页**只能从考试详情页点「阅卷分配」按钮进入**。
    ⇒ 凡是 `goto` 之后要调接口/读数据的地方，先断言 URL 里没有 `?next=`、且
    `localStorage['jwt-token']` 还在；不在就重新 `login.sh`。
26. **被禁用的「阅卷分配」按钮可以安全放行来"看"**（2026-10-01 实测）：
    `status=111`（阅卷已完成）的格子按钮 `disabled=true`，`removeAttribute('disabled')`
    后再 `click()` 能正常进入分配页读到真实模式 —— **纯只读、安全**。
    但页面上有一个**「保存」按钮**，那是写操作（且任务阅卷不可逆），**碰都不要碰**。
    批量脚本务必只读 DOM、不触发任何保存路径。
27. **写脚本"失败"先分清是"保存前失败"还是"保存后失败"**：前者系统未变、补跑即可；
    后者可能已经生效（假阴性）。判断方法就是**失败后立刻全站重扫看真实状态**，
    再决定"补哪几条"。**绝不因为脚本报错就重跑整批** ——
    不可逆操作重复执行，代价远大于多等一次扫描。

## 6. 站点分级与安全策略（重要）

站点注册表：`scripts/sites.conf`（`别名|地址|等级|说明`）

| 别名 | 地址 | 等级 | 含义 |
|---|---|---|---|
| `test` | test.fuulea.com | **test** | 内部测试站，无真实数据 |
| `lyyz` | lyyz.fuulea.com | **prod** | 福建省龙岩第一中学，**真实师生数据** |

> **已核实**：生产站与测试站的前端构建 hash 完全相同（`main-2GBQH3EH.js`），
> 因此本技能的路由表、选择器、字段清单可直接复用；差异只在后端数据与站点配置。

### 按等级执行

| | test | prod |
|---|---|---|
| 只读巡检（读页面/截图/导出） | 直接做 | 可以先做，但**先告诉用户你将在生产站操作** |
| 创建测试对象 | 可做，事后问是否清理 | **禁止**。不许在生产站造测试数据 |
| 修改/删除/发布/下发任何数据 | 需口头确认 | **必须**先说明：改什么、影响哪些班级/学生、能否撤销，取得明确同意后才动 |
| 涉及真实学生成绩、名单 | 无 | **禁止导出到对话外**；只做汇总性核对，不外传、不落盘到共享位置 |

### 生产站铁律

1. **默认只读。** 不确定就问，别试。
2. **绝不"为了看看效果"而在生产站提交表单。** 很多向导点「下一步」就落库
   （见 `/course/new` 的坑），在生产站这是真实数据污染。
3. **绝不批量操作。** 没有"批量删除/批量发布"这类动作，即使技术上可行。
4. **不要动别人的数据。** 只碰用户明确指给你的对象。
5. 涉及学生个人信息的页面（成绩表、学情、名单）：**只报告结论与统计量**，
   不在回复里罗列学生姓名+分数。

### 凭据管理

- 凭据存在 `scripts/.credentials`（`别名|账号|密码`，`chmod 600`），或环境变量
  `FUULEA_ACCOUNT` / `FUULEA_PASSWORD`。**不要**把密码写进 SKILL.md、交付文档或对话里。
- 登录：`bash scripts/login.sh <别名>`（默认 `test`）。

## 7. 边界与安全

- 默认**只读巡检**；发布任务、删任务、解散班级、删题、结束阅卷等**写操作必须显式确认**。
- **向导类页面要警惕"中途即落库"**：`/course/new` 第 1 步点「下一步」就已创建课程，
  没有最终确认页。**填表前先把字段值跟用户确认好**，别边摸索边点下一步，
  否则会留下垃圾数据（只能事后去 `/course/:id/edit` 删）。
- 测试站数据可被他人看到，创建测试对象时用可识别名字，事后询问是否清理。
- 账号密码只存本机 `scripts/login.sh`，不进文档、不外传。
- 站点是 Angular SPA，DOM 结构随版本变化；选择器失效时改用 `eval` 文本匹配，不要硬赌 class。
