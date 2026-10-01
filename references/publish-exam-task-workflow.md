# 批量「发布考试学科任务」+「阅卷分配(任务阅卷)」SOP

> 场景：考试的各学科已「关联已有试卷」，但还没**发布**成学生任务；需要批量发布，
> 并把阅卷方式设为「任务阅卷」。
> 本文是 2026-09-29 在龙岩一中生产站跑通 44 条后的作业标准。

## 0. 一句话流程

```
scan_publish_state.js                        # ① 只读：全站 考试×学科 的「绑卷+发布」状态
pending_items.py scan.jsonl items.jsonl      #    生成待发布清单（每次动手前重扫，别复用旧清单）
   → 用户确认清单与参数
publish_exam_task.js --dry   # ② 空跑：走到"发布任务"前一步，校验时间/班级，不提交
publish_exam_task.js         # ③ 写：逐条发布（护栏 + 发布后复核）
assign_task_marking.js --dry # ④ 空跑：勾「任务阅卷」不保存
assign_task_marking.js       # ⑤ 写：勾「任务阅卷」+保存 + 重载复核
scan_publish_state.js                        # ⑥ 只读：全站重扫
diff_publish_state.py 前 后 items --expect-time ".."   #    与基线逐格 diff（新增==清单、无取消发布、无换卷、时间）
```

工具在 `scripts/cdp/`（**CDP 驱动，不用 agent-browser CLI**，原因见第 6 节）。

```bash
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
SK=~/.workbuddy/skills/fuulea-teaching-cloud
cd $SK/scripts/cdp

node scan_publish_state.js /tmp/pub_state.jsonl                     # 全站
python3 pending_items.py /tmp/pub_state.jsonl items.jsonl           # 出待发布清单
node publish_exam_task.js items.jsonl out.jsonl --limit 1 --dry     # 空跑 1 条
node publish_exam_task.js items.jsonl out.jsonl --config cfg.json  # 全量（参数见下）
node assign_task_marking.js items.jsonl asg.jsonl --limit 1 --dry
node assign_task_marking.js items.jsonl asg.jsonl
```

`items.jsonl` 每行：`{"exam":"29194","examName":"…","sub":"地理","paper":"81813364"}`

## 1. 怎么算「待发布」

逐场打开 `/exam/<id>/detail`，按【学科】切块看该行：

| 行内特征 | 含义 |
|---|---|
| `制作答题卡 或 关联已有试卷` | 该科**没绑卷** → 发布按钮灰掉，无法发布 |
| `考试内容：<编号>` + 发布按钮**可点** | 已绑卷、**未发布** ⇒ **待发布** |
| `2024级10班、2024级18班 时间: …` | 已发布过 ⇒ 跳过 |

### ⚠️ 判定「已发布」不能用「有没有 `时间:`」

有的考试在**考试层面**就带时间（整场考试建的时候填了时间），表现为：
```
【数学】 时间: 09-24 12:00 - 09-24 14:00 修改 制作答题卡或关联已有试卷 --- 发布 --- …
```
它其实**没发布**。实测漏判了 29170(英语) 与 29111(语文) 两条。

**正确判据：行里有没有班级名 `20xx级N班`。**

### ⚠️ 生产站是"活的"：动手前必须重新扫描，且别碰别人刚做的事

2026-09-30 实测：当天上午刚绑好的 39 个学科里，**有 1 个（29186 地理）在几十分钟内
已经被学校老师自己在平台上发布了**（时间 `09-28 17:47 - 18:47`，和我们约定的参数不同）。

⇒ 两条纪律：

1. **每次动手前重新跑一次 `scan_publish_state.js`**，用最新的 `pending_items.py` 出清单，
   不要复用上一次的清单文件（哪怕只隔了半小时）。
2. **"已发布就跳过"是幂等护栏自动完成的**，但要人工记住：
   跳过的那条**可能是别人做的**，它的时间是别人设的 —— **不要为了统一参数去改它**，
   也不要用 `取消发布` 再重发（那会覆盖别人/学生的既有数据）。
   在报告里单独列出来说明即可。

## 2. 发布抽屉（发布设置 / 选择学生 / 发布成功）

点学科行的「发布」→ 右侧抽屉，三步：① 发布设置 ② 选择学生 ③ 发布成功。

**基本信息**
- 任务名称：`<考试名> <学科>`，默认值，一般不改
- 发布时间 `publishedAt`：placeholder「立即发布」，**留空=立即发布**
- 截止时间 `endAt`：默认 2 天后
- 提交后可见 `showAnswerAt`：disabled，随发布时间走

**基础设置**：考试 / 教师批阅 / 不允许晚交（三个 `ant-select`，默认即可）
**错题重练**：个性错题 / 高频错题 / 不重练（默认不重练）
**更多设置**：关闭学生讲题

### 日期时间控件怎么填（关键）

`nz-date-picker nzformat="MM-dd HH:mm"`，**直接往 input 里打字不会写进表单模型**，
只会留下"看起来对了"的字符串。必须走控件自己的流程：

```
1. 点 .ant-picker 容器（或 focus+click 它的 input）→ 弹出面板
2. 点日期格 td.ant-picker-cell[title^="09-28"]（title 形如 "09-28 00:00"，只到分钟）
3. 点小时列：.ant-picker-time-panel-column 第 0 列的 li（按 textContent 匹配 "17"）
   点分钟列：第 1 列的 li（匹配 "00"）
   ⚠️ 这些 li 上**没有 data-value**，只能按文本匹配
4. 点面板右下角 .ant-picker-ok button（"确定"）
```

设完读回 input.value 应等于 `MM-dd HH:mm` 字符串（如 `09-28 17:00`）。

### 选择学生

- 顶部有 checkbox「管理的班级」。**默认未勾选 → 页面显示"没有可用班级"**，
  必须勾上才会列出班级（龙岩一中：2024级9/10/18/19班 + 测试班级 + 2025级/2026级若干）
- 班级**不是原生 checkbox**：每个班是 `<div class="chose-class_checkbox"><span>2024级9班</span></div>`
  - 选中标记 = 该 div 多了 class **`select`**
  - 点它的 `<span>` 即可切换
  - 校验只能看 `select` class，**不能**找 `input[type=checkbox]`（那是外层的"全选/行政班"）
- 右下角「已选: N 个班级」是权威计数

### ⚠️ 提交后班级会被服务端收窄（不是脚本 bug，别当成失败）

抽屉里可选「管理的班级」全部 11 个班，但**发布任务后，行内班级列表往往少于你勾的数量**——
站点会把班级收窄到**该学科实际有效的班**（选科/班级配置层面）。

实测（2026-09-29 全站 68 个已发布学科）：

| 学科 | 行内实际班级数 | 说明 |
|---|---|---|
| 地理 | 恒 2 个 | 各场、各发布人都一样 |
| 化学 | 恒 3 个 | 同上 |
| 生物 | 4 个 | |
| 历史 | 1 个 | |

`2024级9班` 在 68 行里**从未出现过**。勾 4 个班提交后，地理行只剩 `2024级10班、2024级18班`
——这是**平台行为**，不是漏选。

**因此「发布后复核」不能断言"班级数 == 目标数"**（那会 100% 误报失败）。
只能断言：① 行内出现班级名（= 已发布）；② 时间串精确等于期望值。班级数只**记录**、不判失败。

### 行内班级列表的显示规则

```
2 个班  →  「2024级10班、2024级18班」          ← 全部列出
≥3 个班 →  「2024级10班、2024级19班等3个班级」  ← 只列前 2 个 + 等N个班级
```
⇒ **解析真实班级数要看 `等(\d+)个班级`**，光数行里的班级名会把 3/4 个班误读成 2 个。

### 发布成功

底部「发布任务」→ 出现绿勾页，「发布成功 / 可在任务查看当前发布的作业」+「确定」。
**判据只能用「可在任务查看当前发布的作业」**——步骤条上一直写着"3 发布成功"，会误判。

## 3. 阅卷分配（任务阅卷）

学科行「阅卷分配」→ `/exam/:id/offline/distribute/:examSubjectId/teachers?label=..&paperId=..&subjectId=..&examStatus=..`

- 顶部 `nz-radio-group`：`考试阅卷`（默认）/ `任务阅卷`
- 选「任务阅卷」→ 阅卷教师区变成提示文字，「添加阅卷老师」置灰
- 右上角「保存」→ 保存后一般跳回考试详情页
- 复核：重新打开该 distribute URL，确认「任务阅卷」仍被选中

> ⚠️ **不可逆**：页面原文「"任务阅卷"开启后，教师按任教班级各组完成阅卷即可，无需单独设置。
> 但开启后将无法重新设置为"考试阅卷"，请谨慎使用。」
> 执行前必须跟用户确认范围，且**只动本次新发布的任务**，别碰已有阅卷安排的老任务。

### ⚠️ 复核时的假阴性（2026-10-01 实测，务必读）

`nz-radio-group` 会**先用默认值 `考试阅卷` 渲染，再由异步请求回填真实值**。
"打开页面 → 立刻读 radio" 会读到**默认值**。

实测：43 条全部改成任务阅卷成功（保存后重载复核均为 `任务阅卷`），
但独立复核脚本只读一次，报 **43 条仍是考试阅卷**。差点据此认定写操作没生效。

- 读「当前值」必须**连续两次读数一致**才算数（`scripts/cdp/scan_marking_mode.js` 已内建）
- 旁证：切成任务阅卷后 distribute 页 URL 的 `examStatus` 由 `11` 变 `15`
- 收尾用 `scripts/cdp/diff_marking_mode.py` 逐条对账，别"看几条没问题就算过"

```bash
node $SK/scripts/cdp/scan_marking_mode.js items.jsonl before.jsonl
node $SK/scripts/cdp/assign_task_marking.js items.jsonl out.jsonl
node $SK/scripts/cdp/scan_marking_mode.js items.jsonl after.jsonl
python3 $SK/scripts/cdp/diff_marking_mode.py before.jsonl after.jsonl \
        --expect 任务阅卷 --expect-count 43
```

## 4. 护栏（脚本已内建）

| 护栏 | 行为 |
|---|---|
| 卷号校验 | 打开抽屉前核对行内「考试内容：<编号>」= 清单里的编号，不符中止 |
| 幂等 | 该行已有班级列表 ⇒ 跳过 |
| 时间校验 | 两个 picker 的 value 必须精确等于期望串，否则**不提交**并关抽屉 |
| 班级校验 | 「已选 N」必须 = 目标数，且逐班 `select` class 命中，且无多选，否则**不提交** |
| 发布后复核 | 重载列表页确认该行已带时间与班级；**时间串必须精确相等**；班级数只记录不判定（见上） |
| 阅卷分配复核 | 保存后重载 distribute 页确认已持久化 |

## 5. 收尾：逐格 diff

把 `考试 × 学科`（龙岩一中 17×9=153 格）**全量重扫**再与基线比：

- 新增发布数 == 清单数
- 无"被取消发布"的格子
- 无"卷号被改动"的格子
- 时间串与清单一致（`09-28 17:00 - 09-28 18:00`）
- ⚠️ **不要**拿"班级列表与清单一致"当检查项——服务端会收窄班级（见第 2 节）；
  正确做法是比对**班级数是否与基线相同**（发布前后同一条应保持同一组班）

## 6. 为什么走 CDP 而不是 agent-browser CLI

生产站页面在标签被 Chrome 冻结/丢弃时会变成 `about:blank`，
`agent-browser open/get/eval` 会持续返回空，且 `close --all` 会连登录态一起清掉。

`scripts/cdp/cdp.js` 的做法：
- 用 `agent-browser get cdp-url` 拿到 CDP 端口，自己连 `Page` target
- 每次连接/导航后调 `Page.setWebLifecycleState({state:'active'})` + `Target.activateTarget`
  —— 这是**防止标签被冻结**的关键
- `session.js` 包一层：eval/goto 失败自动重连重试
- 登录走 `login.js`：`Runtime.evaluate` 读页面 + `Input.insertText` 填 Angular 表单，
  幂等（已登录直接返回）

其它细节：
- `execFileSync('agent-browser', ['get','cdp-url'])` 默认取 **`default` 会话**；
  要换会话就设 `AGENT_BROWSER_SESSION`
- 站点在 `login.js` 里用 `FUULEA_BASE` 覆盖（默认 lyyz）
- 截图用 `Page.captureScreenshot`

## 7. 已知坑速查

| 现象 | 原因 / 解法 |
|---|---|
| `get url` 恒为 `about:blank`、eval 卡死 | 标签被冻结 → 见第 6 节；CDP 连接后必须 `setWebLifecycleState('active')` |
| `browser: PAPER…: unbound variable` | 变量后紧跟全角字符，写 `${VAR}` |
| 模板字符串里正则失效 | JS 模板串里 `\d` 会被吃掉（→`d`），要写 `\\d` |
| 选择学生页"没有可用班级" | 没勾「管理的班级」 |
| 班级勾选数不对 | 误点了外层的"全选"；按 `chose-class_checkbox.select` 校验 |
| 时间设了但没生效 | 用了打字法；必须走日期格+时间列+确定 |
| 发布后班级数比勾选数少 | **正常**：服务端收窄到该学科有效班（地理 2、化学 3…），别重试 |
| 数行里班级名只有 2 个，以为只发了 2 个班 | 3 个班以上显示为「前2个 + 等N个班级」，要解析 `等(\d+)个班级` |
| 清单一算比预期少几条 | **生产站是活的，别人也在操作**：有人在这期间自己发布过了 → 重新扫描出清单，别复用旧清单 |
| 明明"待发布"却点不动发布 | 该科未绑卷（`制作答题卡或关联已有试卷`），或阅卷已结束 |
| 阅卷分配按钮灰 | 该科未发布，或阅卷已结束 |
| `FAIL … :: 行读取失败 no-label` | 刚打开 detail 页，「学科列表」还在转圈（截图里是 `添加科目` spinner）→ **渲染竞态**，不是"行不存在"。别当成数据问题去查卷号。`publish_exam_task.js` / `assign_task_marking.js` 已内建重试（最多 4 次，第 2 次起重新 goto），2026-09-30 实测 43 条里中招 1 条 |
