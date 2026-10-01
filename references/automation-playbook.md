# agent-browser 实操手册（针对 fuulea SPA 调过）

> ⚠️ **长时间批量操作（几十条写操作）不要用 agent-browser CLI**：
> 生产站标签会被 Chrome 冻结/丢弃，表现为 `get url` 恒为 `about:blank`、eval 卡死，
> 且 `close --all` 会连登录态一起清掉。
> 改用 `scripts/cdp/`（CDP 驱动 + `Page.setWebLifecycleState({state:'active'})`），
> 见 `references/publish-exam-task-workflow.md` 第 6 节。
> 本手册仍适用于短操作（登录、单页查看、巡检）。

## 0. 起手式

```bash
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin   # 必带，否则 command not found
SK=~/.workbuddy/skills/fuulea-teaching-cloud
export AGENT_BROWSER_SESSION="fuulea-lyyz"   # 会话必须命名（见 §2）
bash $SK/scripts/login.sh test      # 测试站
bash $SK/scripts/login.sh lyyz      # 龙岩一中生产站 —— 先读 SKILL.md 的安全策略
```

站点别名与等级见 `scripts/sites.conf`；凭据见 `scripts/.credentials`（chmod 600）。
**生产站（tier=prod）默认只读**，脚本会强制要求 `--yes` 才跑巡检。

页面打不开 / 登录反复超时时，第一动作：

```bash
bash $SK/scripts/browser.sh hard-reset        # 或: bash $SK/scripts/exam_papers.sh lyyz reset
```

## 1. 常用命令

| 目的 | 命令 |
|---|---|
| 打开 | `agent-browser open https://test.fuulea.com/tk` |
| 取全文 | `agent-browser read`（比截图省 token，首选） |
| 取可交互元素 | `agent-browser snapshot -i` |
| 点击 | `agent-browser click @eN`（**@ 语法**；`[ref=eN]` 会失败） |
| 填表 | `agent-browser fill @eN "文本"` |
| 截图 | `agent-browser screenshot /tmp/x.png`（**位置参数，无 --path**） |
| 执行 JS | `agent-browser eval "..."` |
| 看日志 | `agent-browser console` / `console --clear` |
| 取 URL | `agent-browser get url` |
| 取文本 | `agent-browser get text [sel]` |
| 列标签页 | `agent-browser tab`（不是 `tabs`）；`tab list --json` 含 `targetId` |
| 关闭 | `agent-browser close`（必须） |

CLI 自检：`agent-browser --help`、`agent-browser skills get core --full`

## 2. SPA 等待策略

- ❌ `wait --load networkidle` → 会卡住（轮询、长连接不断）
- ❌ **固定 `sleep` 赌渲染** → 冷启动/弱网必翻车。一律**轮询到目标出现**。
- ✅ `open` 后轮询 `read` / `eval document.body.innerText.length`，或轮询目标选择器
- 首次进入某模块（要下载 lazy chunk）多等 2 秒

### 会话必须命名，且 `open` 后必须确认"真的渲染出来了"

```bash
export AGENT_BROWSER_SESSION="fuulea-<别名>"   # 别用共享的 default 会话
```

> `open` **回 `✓` 不等于打开成功**。SPA 的 lazy 渲染、冷启动、坏掉的会话状态，
> 都会让 `open` 报成功而页面其实什么都没有。

判断"真的打开了"要三个条件同时满足（`scripts/browser.sh open-checked` 已封装）：

1. `agent-browser get url` 不是 `about:blank`；
2. `eval 'document.body.innerText.length'` > 0；
3. 期望的选择器（如 `.ant-list-item`）能查到元素。

### 会话状态坏掉 + `close --all` 清不掉（2026-09-29 实测，务必知道）

**症状**：`open` 回 `✓`，但 `get url` / `tab` 永远是 `about:blank`，`read` 拿到空；
诡异的是 `console` 却能打印出**目标站**的日志（两个"当前页"在打架）。
登录脚本会 3 次重试全超时。

**排除过的猜测**（别重复试）：

- 会话名带连字符？→ 无关（连字符/下划线/纯字母都试了）
- 多个 agent 抢 `default` 会话？→ 单人单会话也能复现
- 换个 `close` 姿势？→ 没用

**真正的原因**：`~/.agent-browser/` 下的**会话状态文件坏了**，
而且 `close --all` **清不掉它** —— 它会报 `✓ Closed session: X`，
但 `X` 仍在 `session list` 里，下次同名启动继续命中坏状态。
换个新名字就"好了"，这正是把人带偏成"名字有问题"的原因。

**解法**（三步缺一不可）：

```bash
agent-browser close --all
kill -TERM "$(cat ~/.agent-browser/<会话>.pid)"     # 杀残留守护进程
rm -f ~/.agent-browser/<会话>.{pid,sock,target,stream,engine,version}   # 删状态文件
```

或直接用封装好的：

```bash
bash scripts/browser.sh hard-reset          # 只清本会话 + fuulea-* 遗留
bash scripts/browser.sh hard-reset --all    # 清全部会话状态（谨慎）
bash scripts/exam_papers.sh <别名> reset     # 同上，按站点
```

实测：彻底做完这三步，原本"怎么都不行"的会话名**立刻恢复正常**。
只动 `~/.agent-browser/` 下的会话状态文件，不动 `browsers/`（浏览器二进制缓存）和 `tmp/`。

### 其它会话层注意事项

- `close --all` 之后**紧接着** `open` 有竞态：浏览器还在退出，新页面可能一直不渲染。
  中间加 `sleep 2~3`。
- 冷启动首次拉起 Chromium 到登录页可交互，实测约 **15 秒**。
- 每个 `--session <name>` 是**一个独立浏览器进程**。一次开太多会话（实测 8+）会拖垮机器、
  渲染进程莫名死亡变 `about:blank`。**一个站点一个会话，用完就 `close`。**
- `agent-browser tab`（不是 `tabs`）可以列标签页；`tab list --json` 给出 `targetId`。
  排查"两个当前页"时很有用。

## 3. 点击的三层降级策略

1. `agent-browser click @eN`（ref 来自同一条命令里的 `snapshot -i`，别跨命令复用）
2. `agent-browser click "text=按钮名"` —— **本站经常失败**（Angular 的 `<!---->` 注释节点干扰语义匹配）
3. `agent-browser eval` 手动 DOM 点击（最稳）：

```js
(()=>{
  const s=[...document.querySelectorAll('span,div,a')]
    .find(x=>x.textContent.trim()==='加入选题' && x.offsetParent);
  const btn = s && (s.closest('button') || s);
  if(!btn) return 'not-found';
  btn.click();
  return 'clicked';
})()
```

**关键**：入口常是 `<span><button nz-button class="ant-btn ant-btn-primary">…`
点外层 span 无效，要点到内层的 `<button>`（用 `.closest('button')` 从内往外找，
或从 span 往下 `querySelector('button')`）。

## 4. 判断"点了之后发生了什么"

```js
// 是否开了弹层（本站很多操作开 modal 而非跳路由）
agent-browser eval "(()=>{const m=document.querySelector('.ant-modal'); return m? m.innerText.slice(0,1200):'no-modal'})()"
agent-browser eval "(()=>[...document.querySelectorAll('.cdk-overlay-container')].map(x=>x.innerText.slice(0,200)))()"

agent-browser get url          // 是否跳了路由
```

常见：考试卡片「成绩分析」→ 开 `.ant-modal`；「发布任务」→ 跳 `/exercise/publish/task`。

### 删除类操作是 popconfirm 气泡，不是 modal

本站删除按钮（如 `/course/:id/edit` 的「删除课程」）点下去弹的是
`.ant-popover`（气泡确认），文案形如「确定要删除该课程吗？ 取消 确定」。
只查 `.ant-modal` 会误判成「点了没反应」。正确姿势：

```js
// 1) 点删除按钮
agent-browser eval "(()=>{const el=[...document.querySelectorAll('span,button')].find(e=>e.textContent.trim()==='删除课程'&&e.offsetParent); const b=el&&(el.closest('button')||el); b&&b.click(); return b?'clicked':'nf'})()"
// 2) 点气泡里的「确定」
agent-browser eval "(()=>{const pop=document.querySelector('.ant-popover'); if(!pop)return 'no-pop'; const b=[...pop.querySelectorAll('button')].find(x=>/确定/.test(x.innerText)); b&&b.click(); return b?'confirmed':'no-btn'})()"
```

不同页面的确认弹层文案见 `references/business-flows.md` 对应流程。

## 5. 定位元素（eval 模板）

```js
// 列出页面上所有含某文本的叶子节点（带可见性）
(()=>[...document.querySelectorAll('*')]
  .filter(e=>e.children.length===0 && e.offsetParent && /关键词/.test(e.textContent))
  .map(e=>e.textContent.trim()).slice(0,40))()

// 看元素结构（tag/class/父级），用于构造选择器
(()=>{const e=[...document.querySelectorAll('*')].find(x=>x.textContent.trim()==='XXX'&&x.offsetParent);
 return {tag:e.tagName, cls:e.className, parent:e.parentElement.className}})()
```

## 6. 已知坑位清单

| 现象 | 原因 / 解法 |
|---|---|
| `curl` 返回 403 nginx | 默认 UA 被挡；加 `-A "Mozilla/5.0 ... Chrome/126.0"` |
| `command not found: python3/curl/date` | PATH 没导出 |
| `Element not found: text=xxx` | 语义定位器在 Angular 页面不可靠 → 用 eval |
| 点了没反应 | 点到了外层 span/div，没点到 `<button>` |
| ref 失效 | 页面重渲染后重新 `snapshot -i`，与 click 放同一条命令 |
| 页面一直加载 | 别用 networkidle，改 sleep |
| 截图没内容 | 需要文本就用 `read` / `eval innerText`，别依赖看图 |
| 浏览器进程残留 | 任务结束 `agent-browser close`（`--all` 清所有会话） |

## 7. 批量巡检脚本

```bash
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
mkdir -p /tmp/fuulea/pages
while read -r slug route; do
  [ -z "$slug" ] && continue
  agent-browser open "https://test.fuulea.com$route" >/dev/null 2>&1
  sleep 5
  agent-browser read > "/tmp/fuulea/pages/$slug.txt" 2>/dev/null
  echo "$slug -> $(wc -c < /tmp/fuulea/pages/$slug.txt) bytes"
done <<'EOF'
course /course
task /task
exam /exam
tk /tk
target_student /target/for-student
analysis_class /analysis/class
classroom /classroom
booklet /booklet
vocabulary /vocabulary
algo_skill /algo/skill
EOF
agent-browser close
```

判断页面是否异常：文本里出现「暂无数据 / 加载中 / 服务器开小差啦 / 获取失败 / 未找到相关内容」需区分是
**真空数据**还是**接口报错**，配合 `agent-browser console` 看。

## 8. 从源码核实地形（无需登录也能做）

```bash
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
curl -s -A "$UA" https://test.fuulea.com/ | grep -o 'main-[A-Z0-9]*\.js'   # 找主 bundle
curl -s -A "$UA" https://test.fuulea.com/main-XXXX.js -o main.js
# 中文是 \uXXXX 转义，先解码再看
node -e "const fs=require('fs');let s=fs.readFileSync('main.js','utf8');
s=s.replace(/\\\\u([0-9a-fA-F]{4})/g,(m,h)=>String.fromCharCode(parseInt(h,16)));
fs.writeFileSync('main.dec.js',s)"
# 然后 grep "loadChildren" 拿路由表，grep 'label:"' 拿菜单
```

## 9. 后端 API 与鉴权（实测 2026-09-29）

- **同源前缀** `/v2/`（等价于 `https://api.fuulea.com/v2/`，站点做了同源代理）。
  资源表里能直接看到站点自己发的请求，这是**定位接口最快的方法**（只读、无副作用）：

  ```js
  agent-browser eval "(()=>[...new Set(performance.getEntriesByType('resource').map(e=>e.name).filter(n=>/\/v2\//.test(n)))])()"
  ```

- **已知只读接口**（都用页面的登录态）
  | 接口 | 用途 |
  |---|---|
  | `/v2/site/<站点别名>/` | 站点信息（含 `siteId`，lyyz=859） |
  | `/v2/course/category/list/` | 课程分类 |
  | `/v2/course/localSchool/list/?pageSize=999&subjectId=<sid>` | **校本课程**列表 |
  | `/v2/course/eliteSchool/list/?pageSize=999&subjectId=<sid>` | 名校课程列表 |
  | `/v2/course/recentTask/list/?subjectId=<sid>` | 最近使用 |
  | `/v2/classrooms/grades/?siteId=<siteId>` | 年级列表 |

- **鉴权是请求头，不是 Cookie**：
  - token 在 `localStorage['jwt-token']`
  - 请求头形如 `Authorization: jwt <token>`（注意前缀是小写 `jwt `，不是 `Bearer`）
  - 另有一个签名头 `fl-sec-sign: <32位hex>,<unix秒>`，**由前端计算，随 URL+时间变化**
  - ⇒ 自己用 `fetch` 直接打接口会得到 `400 {"detail":"Auth Error. 1000"}` 或缺鉴权 `401 {"detail":"身份认证信息未提供。"}`。
    **结论：不要尝试绕过签名直连 API，一律走 UI 操作。**
    想看站点发了什么请求，用上面 `performance.getEntriesByType('resource')`，
    或临时 patch `XMLHttpRequest.prototype.setRequestHeader` 抓头。

- **学科 ID 表**在 `localStorage['grade_subjects']`（JSON，`val` 数组）。
  本站课程体系用的是「grade=2」那套：

  | 学科 | 语文 | 数学 | 英语 | 物理 | 化学 | 生物 | 历史 | 地理 | 政治 |
  |---|---|---|---|---|---|---|---|---|---|
  | **grade=2（课程在用）** | 7 | 1 | 6 | 3 | 2 | 5 | 8 | 9 | 10 |
  | grade=1（另一套） | 13 | 4 | 14 | 11 | 12 | 15 | 16 | 17 | 18 |

## 10. 课程 / 章节 / 试卷 的检索路径（实测）

| 想去 | 打开 |
|---|---|
| 某学科课程列表 | `/course?schoolSubject=<subjectId>` |
| 课程详情 | `/course/<courseId>` |
| 课程某一章 | `/course/<courseId>/chapter/<chapterId>?chapterName=<名>&chapterPath=<名>` |

**课程列表页**：分类是「校本课程 / 名校课程」，下面按学科筛选。
同一学科可能有**多个**课程（如实测英语有 `2026级考试汇总`/`2025级考试汇总`/`2024级英语考试汇总` 三个），
**必须按名字挑对**（本次目标是 `2024级<学科>考试汇总`）。

**章节页左侧目录 = `nz-tree`**。取章节名与切章的正确姿势：

```js
// 章节名（完整名在 [title] 属性里，显示的文本会被 CSS 截断成 "…"）
const NAV = `(()=>{
  const tree=document.querySelector('nz-tree.ant-tree')||document.querySelector('.ant-tree');
  const nodes=[...tree.querySelectorAll('.ant-tree-treenode')]
    .filter(nd=>nd.offsetParent && nd.querySelector('[title]'));   // ⚠️ 必须过滤
  return nodes.map(nd=>nd.querySelector('[title]').getAttribute('title'));
})()`;

// 切到第 i 章（索引要与上面同一套过滤，否则错位一位）
const CLICK = i => `(()=>{
  const tree=document.querySelector('.ant-tree');
  const nodes=[...tree.querySelectorAll('.ant-tree-treenode')]
    .filter(nd=>nd.offsetParent && nd.querySelector('[title]'));
  (nodes[${i}].querySelector('.ant-tree-node-content-wrapper')||nodes[${i}].querySelector('[title]')).click();
  return 'ok';
})()`;
```

**两个必须遵守的坑**：

1. **装饰性节点导致索引错位**：树里 `index 0` 是一个**没有 `[title]`** 的可见空节点
   （和第一个真节点同 y 坐标）。取节点和点节点**两处必须用同一套 `.filter()`**，
   否则点到的永远是「上一章」，表现为「读到的卷号整整错一位」。
   ⚠️ 这个 bug 会让整批数据看起来**完全合理**（每章都有卷号），极难肉眼发现——
   务必用「已知答案」的章节做交叉校验（如已绑定考试的卷号）。
2. **切换后要回验**：点完章节后，用 URL 的 `chapterName` 参数确认真的切过去了
   （通常 2~3 秒内完成），再读内容。否则会读到上一章的正文。

**试卷号在章节页正文里**，格式固定：

```js
const m = (document.body.innerText.split('退出登录').pop()||'')
  .match(/#(\d{6,})\s*满分\s*(\d+)\s*分\s*(\d+)\s*道题/);
// m[1]=试卷号 m[2]=满分 m[3]=题量
```

若该章显示「催录题目 / 本章题目尚未录入」⇒ 这一章**没有试卷**，无法关联。
