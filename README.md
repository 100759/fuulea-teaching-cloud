# 智慧教学云（fuulea）站点操作自动化技能包

> WorkBuddy / CodeBuddy Agent Skill —— 用浏览器自动化与直连 API 驱动「智慧教学云 / 辅立码课」平台，
> 完成登录、模块巡检、批量绑卷、批量发布考试任务、阅卷分配改造、班级任课教师补录、成绩模板批量下载与填充等运维工作。

本仓库是 [`~/.workbuddy/skills/fuulea-teaching-cloud/`](.) 技能目录的公开镜像。
把它放进本地 skill 目录即可被 Agent 加载使用。

---

## ⚠️ 使用前必读

- **本技能面向真实生产环境。** 仓库中的流程默认包含**写操作**（发布考试、绑定试卷、
  开启任务阅卷、添加任课教师、导入成绩）。
- **生产站默认只读。** 任何写操作必须：说明改什么 / 影响谁 / 能否撤销 → 取得明确同意 →
  先试 1 条 → 放量 → **重扫全量逐条对账**。部分操作**不可逆**
  （如「考试阅卷」→「任务阅卷」平台明确不可回退）。
- **请使用自己的账号与凭据。** 本仓库**不包含**任何账号、密码或 token
  （`.credentials` / `.api-creds.json` 已在 `.gitignore` 中排除）。
  请按下方「凭据配置」自行配置。
- 使用者需自行承担在真实学校数据上执行脚本的责任；请遵守所在机构的数据安全规定。

---

## 安装

```bash
git clone https://github.com/100759/fuulea-teaching-cloud.git
cp -r fuulea-teaching-cloud ~/.workbuddy/skills/
```

依赖：`node`（≥18）、`python3`、[`agent-browser`](https://www.npmjs.com/package/agent-browser)
或任意 Chrome + CDP 环境。

## 凭据配置

```bash
cd ~/.workbuddy/skills/fuulea-teaching-cloud/scripts
cat > .credentials <<'EOF'
# 格式: 别名|账号|密码
test|你的测试站账号|密码
lyyz|你的生产站账号|密码
EOF
chmod 600 .credentials
```

站点别名与等级登记在 `scripts/sites.conf`。也可用环境变量
`FUULEA_ACCOUNT` / `FUULEA_PASSWORD` 覆盖。

---

## 目录结构

```
fuulea-teaching-cloud/
├── SKILL.md                      # 技能主文档（触发器、站点地图、流程索引）
├── references/                   # 深度参考文档
│   ├── site-map.md               # 路由清单与页面结构
│   ├── site-family.md            # 多租户站点家族与新增站点流程
│   ├── business-flows.md         # 核心业务流程走查
│   ├── automation-playbook.md    # agent-browser 命令与踩坑
│   ├── api-direct.md             # ★ 直连 /v2 接口：签名算法与批量只读用法
│   ├── bind-papers-workflow.md   # ★ 跨学科批量绑卷 SOP
│   ├── publish-exam-task-workflow.md  # ★ 批量发布考试任务 + 阅卷分配 SOP
│   └── add-class-teachers-workflow.md # 班级任课教师补录 SOP
└── scripts/
    ├── sites.conf / login.sh / browser.sh / smoke.sh / lint.sh
    ├── api.js                    # /v2 直连客户端（含 fl-sec-sign 签名）
    ├── murmur3.js                # murmurhash3_x64_128 实现
    ├── scan_exam_cells.js        # 全站考试配置盘点（153 格）
    ├── gap_report.py             # 缺口台账（md / xlsx）
    ├── download_exam_templates.js# 成绩上传模板批量下载
    ├── bind_paper.sh / exam_papers.sh
    ├── cdp/                      # CDP 驱动的批量写操作脚本
    └── papers/                   # 绑卷流水线（snapshot→scan→plan→verify→bind→audit）
```

---

## 三个最有价值的沉淀

### 1. `/v2` 接口直连 —— 只读批量任务的首选

浏览器只用来**取一次凭据**（`localStorage['jwt-token']` + `uuid`）。
之后所有 GET 走接口，速度提升一个数量级。

三个必需请求头：

| 头 | 值 |
|---|---|
| `Authorization` | `jwt <token>`（注意前缀是小写 `jwt `，不是 `Bearer`） |
| `uuid` | 从站点取 |
| `fl-sec-sign` | `<murmur3_x64_128(key),unix秒>` |

签名 key 由 JWT 签名段派生：`sig[0:3] + sig[8:10] + sig[-5:]`。

> **关键结论：签名是 murmurhash3，不是 md5** —— 曾用 64 万种 md5 组合暴力尝试，零命中。
> 纯 JS 实现在 `scripts/murmur3.js`。缺 sign 报 `400 Auth Error. 1000`，缺 token 报 `401`。

```bash
bash scripts/login.sh <别名>
node scripts/api.js creds      # 取 jwt/uuid → .api-creds.json
node scripts/api.js selftest   # 必须 SELFTEST OK
```

### 2. CDP 脚本绕开浏览器 CLI 冻结

`agent-browser` CLI 在长时间批量写操作下会冻结标签页，表现为 `open` 返回成功但
`get url` 卡在 `about:blank`。`scripts/cdp/` 下的脚本直接走 Chrome DevTools Protocol，
并提供幂等、重试、护栏与前后留证。

同时沉淀了两类「不报错、不崩、只静默出错」的坑，已做成机制：

- `set -u` 下 `$VAR` 后紧跟全角字符 → 整批任务在第一条静默死掉（`scripts/lint.sh` 拦截）
- JS 模板字符串里的 `\d` → 反斜杠被吃掉，页面正则全匹配不上（`scripts/lint.sh` 拦截）

### 3. 批量写操作的标准姿势

```
只读摸底 → 清单给用户看 → 用户批范围（可先试 1 条）
  → 脚本内建护栏（prod 需 --yes、幂等跳过、关键字段校验、失败即非 0 退出）
  → 跑完重扫全量逐格 diff 确认没误伤
  → 出完成报告（含证据与遗留项）
```

---

## 命令速查

```bash
SK=~/.workbuddy/skills/fuulea-teaching-cloud

bash   $SK/scripts/login.sh lyyz                 # 登录
bash   $SK/scripts/lint.sh                       # 写操作前的自检（必跑）
bash   $SK/scripts/browser.sh hard-reset         # 页面卡死/会话状态坏掉时

node   $SK/scripts/scan_exam_cells.js out.jsonl  # 全站考试配置盘点（约 30 秒 / 153 格）
python3 $SK/scripts/gap_report.py out.jsonl out.md out.xlsx   # 缺口台账

bash   $SK/scripts/bind_paper.sh                 # 跨学科批量绑卷流水线
node   $SK/scripts/cdp/publish_exam_task.js      # 批量发布考试学科任务
node   $SK/scripts/cdp/assign_task_marking.js    # 阅卷分配改造
node   $SK/scripts/cdp/add_class_teachers.js     # 班级任课教师补录
node   $SK/scripts/download_exam_templates.js    # 成绩上传模板批量下载
```

---

## 已知坑位（摘要）

| 现象 | 根因 | 处理 |
|---|---|---|
| `open` 返回 ✓ 但页面是 `about:blank` | 会话状态文件损坏 | `scripts/browser.sh hard-reset` |
| 深链进 `/offline/distribute/...`、`/task/import?id=...` 被踢到登录页 | 平台限制 | 只能从界面点进去，不能拼 URL 导航 |
| 读阅卷模式恒读到「考试阅卷」 | `nz-radio-group` 先渲染默认值再异步回填 | 别读界面，用接口 `markByTask`（权威值、无竞态） |
| `nz-select` 类型搜索候选恒空 | `Input.insertText` / 合成事件不触发 | 必须 CDP 逐字符 `Input.dispatchKeyEvent` |
| 截图 before/after 完全一致 | 目标元素在折叠线以下 | 先 `scrollIntoView({block:'center'})` |
| `/v2/tasks/` 返回体是 `results` 不是 `data` | 接口约定 | 取错字段会静默拿到空列表 |

完整清单见 `SKILL.md` 与 `references/`。

---

## License

MIT
