# 站点家族与新增站点

一套前端代码、多所学校独立部署（多租户）。本技能按「站点别名」组织，
所有操作都要先明确**在哪个站**。

## 已登记站点

| 别名 | 地址 | 等级 | 站点名 | 说明 |
|---|---|---|---|---|
| `test` | https://test.fuulea.com | test | 测试站 | 内部测试，无真实数据 |
| `lyyz` | https://lyyz.fuulea.com | prod | 福建省龙岩第一中学 | **真实师生数据** |

登记表：`scripts/sites.conf`，格式 `别名|地址|等级|说明`。

## 为什么可以共用一份路由表

实测（2026-09-29）两个站点首页引用的资源完全一致：

```
polyfills-7R4CRVNH.js
main-2GBQH3EH.js          ← 主 bundle hash 相同
styles-PCYKUGVN.css
```

即 **同一份前端构建**。差异只在：

- 后端数据（班级、学生、任务、考试…）
- 站点配置 `site.name` / `site.config`（决定 logo、站点标题、菜单可见项）
- 租户能力开关，如 `site.editCourse`（控制是否出现「录入」菜单）

因此 `references/site-map.md` 的路由与 `references/business-flows.md` 的流程
对全家族站点通用。**若某天 hash 变了**，说明前端已升级，
需重新核对路由与选择器（做法见本文件末节）。

## 新增一所学校

1. 打开站点首页确认站点全名：
   ```bash
   UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
   curl -s -A "$UA" https://<子域>.fuulea.com/ | grep -o '<title>[^<]*</title>'
   ```
   标题形如 `首页 - <学校名> | '智慧教学云'`。

2. 抓 `main-*.js` 的 hash，与本文件记录比对：
   ```bash
   curl -s -A "$UA" https://<子域>.fuulea.com/ | grep -o 'main-[A-Z0-9]*\.js'
   ```
   - hash 相同 → 直接复用现有路由/流程，只加一行注册即可。
   - hash 不同 → 需重新提路由（见下）。

3. 在 `scripts/sites.conf` 加一行，**等级按数据真实性判断**：
   学校在用的真实站点一律 `prod`。

4. 在 `scripts/.credentials` 加一行 `别名|账号|密码`（`chmod 600`）。
   **没有凭据不要猜、不要试别人的账号** —— 直接问用户。

5. 只读验证：`bash scripts/smoke.sh <别名> --yes`（`prod` 必须带 `--yes`）。

## 前端升级后如何重新提路由

```bash
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
curl -s -A "$UA" https://test.fuulea.com/ -o index.html
grep -o 'main-[A-Z0-9]*\.js' index.html          # 拿到主 bundle 名
curl -s -A "$UA" https://test.fuulea.com/main-XXXX.js -o main.js

# 中文是 \uXXXX 转义，先解码
node -e "const fs=require('fs');let s=fs.readFileSync('main.js','utf8');
s=s.replace(/\\\\u([0-9a-fA-F]{4})/g,(m,h)=>String.fromCharCode(parseInt(h,16)));
fs.writeFileSync('main.dec.js',s)"

grep -o 'path:"[^"]*",loadChildren' main.dec.js    # 顶层模块 → chunk 映射
grep -o 'label:"[^"]*"' main.dec.js                # 侧边栏菜单与角色条件
```

再按 `loadChildren` 里的 `chunk-*.js` 逐层下载、递归 grep `path:"` 即可还原全表。
完整脚本思路见 `references/automation-playbook.md` 第 8 节。
