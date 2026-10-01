# 「导入成绩」接口的真实语义 + 导入结果核对法（2026-10-01 实测）

> 本文只记**实测事实**（附证据），供下次少走弯路。凡未坐实的都标「推测」。

## 1. 接口

```
POST /v2/tasks/import/data/    multipart/form-data
  usernamePrefix = ""          （学生姓名前缀，留空）
  source         = "qt"        （qt=全通教育 zhx=智学网 dameijia=达美嘉
                                haofenshu=好分数 haofenshuMiniTable=好分数-小分表）
  taskId         = <taskId>
  file           = <xlsx>
成功 → 响应体 `{}`；有错 → 响应体是非空对象（行/列级错误映射）
前端组件 `fl-task-import`（chunk-P7ZFKARA.js）：`importTaskData(file, usernamePrefix, source, taskId)`
页面说明原文：「上传**阅卷系统导出**的答题详情。同时上传多个班级成绩时，确保文件名中包含完整的班级名称。」
```

**导入是后台异步**：接口返回 `{}` 只是「已提交」，真正的结果看**左下角消息**。

## 2. 导入结果核对：看左下角消息（不是看页面）

```
GET /v2/inbox/trainer/?page=N        ← page 必须走 params，不能拼进 path（拼进去会 400 Auth Error 1002）
```
通知 title = `导入任务数据`，content 形如：
```json
{"success": {"历史.xlsx": "导入学生: 39"}, "error": {}, "title": "历史.xlsx"}
```
- **成功文案只有「导入学生：N」——不含任何分数信息。**
- 报错样例（真实抓到过）：
  - `{"success":{},"error":{"分数格式错误[行,列]":"[4,I]、[4,J]…"}}` → 分数格格式不对（整批被拒）
  - `{"success":{},"error":{"学生班级未找到":"张三、李四…"}}` → 班级对照表里的学生对不上
  - 换 source 时：`{"未能解析出班级":["历史.xlsx"]}` → 该 source 期望文件里有「班级」列/字段

## 3. ⚠️ 核心结论：qt 导入写入的是「学生名单」，不是分数

**实测（2026-10-01）**：对 105 个任务导入后，用 `snapshot_scores.js` 抓导入前后全量指纹，**323 个任务逐格 diff 零变化**：
`score` / `finishAt` / `hasPhoto` / `id` 全为空。→ **导入只把学生挂到任务上，没有写入任何分数。**

**已排除的因素**（都试过，均无效）：
- 签名 / taskId / 等待时间（30s ~ 4h）
- 文件格式：① 交付原文件（openpyxl，inlineStr + 数字 `t="n"`）
  ② 转 sharedStrings（字符串 `t="s"`）③ **完全复刻学校成功文件的格式**（字符串 `t="s"` + 数字**无 `t` 属性**）
- 数据源：`haofenshuMiniTable` / `haofenshu` / `dameijia`（这三个直接报「未能解析出班级」）
- 任务软删除状态（已 recover 的任务同样写不进）

## 4. 站内「分数」从哪来：答题卡

判据（`GET /v2/tasks/<id>/score/`，每个学生一条）：
| 字段 | 含义 |
|---|---|
| `score` | 总分（>0 = 有分） |
| `finishAt` | 作答/提交时间（有值 = 有作答记录） |
| `hasPhoto` + `photos[]` | **答题卡照片**（`100tifen.com` 域名） |
| `id` | 作答记录 id（null = 无作答记录） |
| `markedBy` | `[{"markBy":"系统"}]` = 系统识别/阅卷 |
任务级（`GET /v2/tasks/?subjectId=<sid>&gradeId=<gid>&type=2&page=N`，返回体是 **`results`** 字段）：
`finishCount` / `studentCount` / `markPercent` / `correctPercent`。

**2026-10-01 全站盘点（465 个任务）**：有分数的**只有 60 个** =
**化学 51 + 英语 4 + 地理 2 + 政治 3**；其余学科全 0。
- 化学 51 个：`markPercent=0` + `correctPercent` 有值（未经阅卷）
- 英语/地理/政治：`markPercent=100` + `markedBy=[{"markBy":"系统"}]`（阅卷/识别产生）
- **共同点：所有有分数的学生都带答题卡照片 `hasPhoto=true`** ⇒ **分数伴随答题卡数据**，xlsx 导入不可能产生照片。

## 5. 批量导入脚本

```bash
SK=~/.workbuddy/skills/fuulea-teaching-cloud
node $SK/scripts/upload_task_scores.js <items.jsonl> <log.jsonl> [--start 1] [--limit 0] [--dry] [--yes] [--source qt]
# items.jsonl 每行: { exam, subject, file, taskId }
# 护栏：prod 必须 --yes；--dry 空跑；--start/--limit 分段；log 幂等跳过；响应必须 {}；任一失败非 0 退出
```
导入前抓基线、导入后抓快照做 diff（脚本在 <工作目录>/.tdocs 或 /tmp 下，函数名 `snapshot_scores.js`）：
```bash
export SK=/Users/fuheng/.workbuddy/skills/fuulea-teaching-cloud   # ⚠️ 不能用 ~（变量赋值不展开）
node snapshot_scores.js items.jsonl before.jsonl   # 记 n / withScore / withFinish / withId / sum
```

## 5.1 ⚠️ 队列必须与「上传对照清单」条数对账（2026-10-01 漏传事故）

**事故**：首批上传队列 105 条，而对照清单列的是 108 条 —— 差 3 条
（`2026-2027第一学期高三8月开学联考` 的 **英语 / 地理 / 政治**）。
文件都在交付目录里、内容完整、站内任务也都存在，**只是没排进队列**，且 `upload_task_scores.js`
的日志是 `ok=105 fail=0` —— **从脚本输出完全看不出漏了**（漏的是"没被排进来"，不是"排进来后失败"）。
用户是靠肉眼发现"英语数量比别人少"才问出来的。

**根因**：交付目录 → 上传队列 这一步的匹配是独立实现，与生成对照清单的实现在两条路径上，
两者没有交叉校验。

**约定**（以后每次上传前必做）：

```bash
# ① 从交付目录枚举"应传"集合（剔除用户指定跳过的学科，如化学）
# ② 从 items.jsonl 枚举"实传"集合
# ③ 断言两个集合相等，差集非空就停下来核对，不许直接上传
# 实测口径：应传 = ✅组文件数 − 指定跳过学科数；实传 = items.jsonl 行数
```

- 断言要按 **(考试, 学科)** 配对做，不是只比总数（总数相同也可能错配）。
- 上传**完成后**再用同一配对重算一次：`实传集合 == 应传集合`。
- 交叉验证看**消息栏条数增量**：`GET /v2/inbox/trainer/` 的 `count`
  上传前记一次、上传后应为 `前值 + 本次条数`（本次 145 → 148）。`count` 是对账的唯一硬指标，
  因为通知文案只有文件名没有考试名，同名科目分不出来。
- ⚠️ 这也解释了为什么"看日志全绿"不等于"传全了"：**绿只证明排进队列的执行成功了**。

## 6. 若目标是「让分数真正进入系统」

xlsx 导入这条路（qt）**不写分数**。可选方向（下次先跟用户确认化学当初怎么做的）：
- 答题卡扫描 / 在线作答 → 系统识别 → 分数（站内现有分数的唯一来源）
- 考试模块的 `POST /exam/subject/<esId>/computing/score/`（计算成绩）、`POST /exam/subject/<esId>/finish/`（结束阅卷）
- 课程章节的「录入」（通知文案：`<课程>:<考试>已录入完成`）
