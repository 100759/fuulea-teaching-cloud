# 智慧教学云 站点地图（实测 + 源码路由表）

> 来源：Angular 路由表逐 chunk 提取 + test.fuulea.com 实测页面。2026-09-29

## 1. 角色与菜单权限

侧边栏由 `initMenu()` 按角色条件渲染：

| 菜单 | 路由 | 可见条件（用户字段） |
|---|---|---|
| 课程 | `/course` | 所有人 |
| 录入 | `/input` | 仅录入站点 `site.editCourse` |
| ├ 教辅分配 | `/input/workbook` | isSuper / isOperateInSchool |
| ├ 录入工单 | `/input/input-self/<user_id>` | 所有人 |
| ├ 个人统计 | `/input/input-statis/<user_id>` | isSuper / keyBoarder |
| ├ 团队统计 | `/input/input-team/` | isSuper |
| ├ 区校统计 | `/input/input-school` | isSuper |
| └ 课程管理 | `/course/manage` | isSuper |
| 任务 | `/task` | 所有人 |
| 考试 | `/exam` | 所有人 |
| 题库 | `/tk` | 所有人 |
| 靶向 | `/target` | 所有人 |
| ├ 对人靶向 | `/target/for-student` | |
| └ 对点靶向 | `/target/for-knowledge` | |
| 学情 | `/analysis` | 所有人 |
| ├ 年级学情 | `/analysis/grade/overview` | isGradeDirector（年级主任） |
| ├ 学科学情 | `/analysis/grade/graph` | isSubjectDirector（学科组长） |
| ├ 班级学情 | `/analysis/class` | manageClassroomIds 非空（班主任） |
| └ 班内学科 | `/analysis/class/graph` | teachClassroomIds 非空（任课老师） |
| 管理 | `/dashboard` | isGradeDirector 或 isSuper |
| 数据 | `/bo/dashboard` | `site_id===1` 且域名匹配 publish/sjzyz1/localhost/192.168.7.233 |

底部栏：搜索 · 消息（未读轮询）· 设置（图谱管理 / 技能控制台 / 我的班级 / 用户管理 / 个人资料 / 问卷调查 / 登录页设置 / 退出登录）

右侧悬浮：**题目篮** `.fixed-basket`（角标 = 已选题数；`/exercise/publish/task` 下隐藏）

## 2. 模块路由全表

### /course 课程
- `/course` 课程首页（"码上提分"精品课程 / 最近使用 / 我收藏的 / 我创建的 / 校本课程）
- `/course/category/:courseId`、`/course/:courseId`（章节预览）
- `/course/:courseId/chapter/:chapterId` 目录；`.../analysis` 章节学情；`.../score` 成绩详情；`.../module/:type` 知识模块
- 管理：`new` `manage` `:courseId/edit` `chapter/new` `chapter/edit` `knowledge/new` `knowledge/:moduleId/edit`
- 练习创建：`exercise/new` → `chooseQuestion` → `choosePaper(/:paperId)` → `addQuestion`（edit 系列同构）
- `/preview/:courseId/chapter/:chapterId`、`/preview/edoc`（电子档）

### /task 任务
- `/task` 列表；Tab：已发布 / 未发布 / 已截止
- 筛选：班级（全部/管理班级/管理年级）· 归属（全部/由我下发/我的班级）· 来源 · 类型
- **来源取值**（实测）：课程、选题练习、资料、答题卡、练习册、班级智能补强、个人智能补强、单词库、背诵任务、个性错题、高频错题
- **类型取值**（实测）：作业、测验、考试、课前预练、课后作业、反扫练习、反扫、限时训练、早午读小测、月考、联考
- 新建任务 `.task-top-tit`：课程任务 / 资料任务 / 制答题卡 / 背诵任务 / **题库选题** / 学科网选题 / 上传试题 / 选卷任务 / 我的试卷
- 快捷入口：批改阅卷 · 完成统计 · 错题反扫 · 班级任务列表 · 任务回收站
- `:id` 详情、`:id/pure/content`、`class/list`、`paper/:paperId/class/:classroomId/score`、`correct-paper`、`import`、`recycle`、`xuekewang`、`algo-control`、`algo-test/:algoId`

### /tk 题库（Itembank）
- Tab：章节选题 / 试卷选题 / 校本题库 / 收藏题目
- 筛选：知识图谱（备考）、来源（课时练习/单元测试/专题练习/月考/开学考试/期中/期末/学业考试/竞赛/高考模拟/高考真题）、题型（单选/多选/非选择/填空/判断/简答/材料/综合）、难度（易中难）、地区、年级、年份、考查范围、关键词
- **AI 搜题**（自然语言描述筛题）；开关：视频题目优先、过滤已使用；排序：最新/最热
- 操作：添加题目、导入题目、`viewQuestion/:id`、`viewPaper/:id`、`question/:id/edit`、`favorite`、`importQuestion`
- 独立页 `/tk/paper/:id`、`/tk/question/:id`

### /exam 考试
- Tab：考试 / 联考；操作：对比分析、纸质答题卡、创建考试；筛选：年级、提交方式
- 卡片字段：`扫卡` 标签、考试名、`#考试号`、年级、科目、类型（月考/考试…）、时间；操作 **阅卷 / 阅问题卷 / 成绩分析 / 更多**
- 路由：`create`、`:id/detail`、`:id/flow-detail`、`:id/offline/distribute/:examSubjectId/teachers`、`:id/marking/:examSubjectId(/detail)`、`:examId/:examSubjectId/submit/progress`、`:examId/analysis`、`:examId/params`、`answer-card`、`templates`、`mine`、`student/nodeAnalysis/:examId/:userId`、`division`（划线）、`edit-achievement`、`search-exam`、`multiple-analysis`
- 扫卡：`/exam/template-answer-sheet/scan`

### /mark 阅卷批改
`/mark`（主页）、`draw-guide`（画框引导）、`slice`（切题）、`mobile`（手机批改）

### /analysis 学情
- 年级：`grade/overview` `grade/graph`（知识点图谱：气泡大小=信度，红=得分率差，绿=较高，灰=0）`score` `node-compare`
- 学科：`subject` `overview` `learningCondition` `score` `node-compare`
- 班级：`class` `overview` `learningCondition` `score` `class/score` `class/graph` `booklet`
- 学生：`student/score` `student/selfstudy` `student/task`
- 个人：`personal/overview` `personal` `taskgraph` `selfstudy` `personalTask/:taskId`
- 其他：`intelligent/task/detail`（智能补强）`node/detail`

### /booklet 错题本
- 个性错题 / 共性错题；筛选得分率区间、题型、知识点；聚合去重
- 重练统计：姓名 / 重练得分率 / 错题任务（完成率）/ 已重练·全部错题（重练占比）/ 日均重练
- 提示：**整体数据统计截止至 MM月DD日 23:59，仅统计已截止任务**
- `statis` `selfBooklet` `list` `common`；日错题本任务发布

### /target 靶向
- 对人靶向 `for-student`：作业/自学靶向（近30天）→ 按学生创建靶向班
- 对点靶向 `for-knowledge`：得分率 / AI分层 / 优劣势 / 分析视角（知识图谱·趋势列表·对标高考）；筛选近5次任务、题型、得分率区间、题量、层级

### /classroom 班级
类型：行政班 / 教学班 / 靶向班。列表字段：编号·名称·类型·人数·允许加入·状态·创建时间·动作（解散/详情）
`export-wrong-questions` 错题导出、`gallery/:classroomId/:studentId/:studentName` 作品画廊

### /vocabulary 单词
教材版本 → 册 → Unit 筛选；列：英文/音标/汉语解释/高频错词/掌握人数/听写次数
操作：加入选题、单词篮、发布单词任务（英译汉/汉译英/听写等考查方式）

### /input 教辅录入
`create` 建教辅（上传电子档）· `workbook/detail/:id` · `input-self/:id` · `input-statis/:id` · `input-team` · `input-school`
工单状态：未开始 / 录入中 / 录入暂停 / 录入完成 / 待扫描 / 已扫描 / 待分配 / 文字录入 / 转码中 / 转码成功 / 转码失败

### /algo 技能控制台
- `/algo/skill`：新建技能 / 我的技能 N 个；状态：草稿·未编译·编译中·编译通过·编译失败·已发布；操作：编辑·删除·预览·开始测试·发布·撤回
- `/algo` 对话工作台（附件：图片/PDF/Word；右侧面板：网页预览·相关题目）
- `/algo/share-page` 分享页

### /student-survey 问卷调查
新增问卷（填**金数据**表单地址 → 自动拉取表单内容与题目数）→ 选班级/学生 → 发布；启用/暂停/查看数据/移除

### /search 搜索
范围：课程/题目/试卷/知识点/任务/考试/录入（+学校/年级/学科）
AI 搜题阶段提示：正在理解你的描述 → 正在匹配相关知识点 → 正在筛选合适的题目 → 正在整理结果，马上就好

### 其他
`bo/dashboard` 学情仪表板（分校/年级；任务类型 作业·测验·考试；阅卷方式 互阅·师阅·自阅）
`template-card` 答题卡模板 · `oauth/authorize` 第三方授权 · `exception` 异常页
`paper/question/refer/group/node` · `video-question/refer-node`
