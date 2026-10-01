#!/bin/bash
# 技能自检：语法 + 本项目的两类"反模式"
#
# 用法:
#   bash scripts/lint.sh          # 全量自检
#   bash scripts/lint.sh -q       # 只报问题
#
# 背景：这两类问题都**不会报错、不会崩**，只会静默给出错误结果/静默中止，
# 排查极费时间，所以做成硬检查。
#   ① `$VAR` 后面紧跟全角字符 → bash 把全角字符当成变量名的一部分 → unbound variable
#      （配合 `set -u` 会让整批任务在第一条就死掉）
#   ② JS 模板字符串里写 `\d` → 反斜杠被吃掉变成 `d` → 页面侧正则全部不匹配
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
QUIET=""
[ "${1:-}" = "-q" ] && QUIET="yes"
FAIL=0

say() { [ -n "${QUIET}" ] || echo "$*"; }

# ---------- 1. shell 语法 ----------
say "== 1. shell 语法 (bash -n) =="
SH_FILES=("${DIR}"/*.sh)
while IFS= read -r f; do SH_FILES+=("$f"); done < <(find "${DIR}/papers" -name '*.sh' 2>/dev/null | sort)
for f in "${SH_FILES[@]}"; do
  [ -f "${f}" ] || continue
  if bash -n "${f}" 2>/tmp/.lint_sh_err; then
    say "   OK   $(basename "${f}")"
  else
    echo "   FAIL $(basename "${f}")"
    sed 's/^/        /' /tmp/.lint_sh_err
    FAIL=1
  fi
done

# ---------- 2. node 语法 ----------
say "== 2. node 语法 (node --check) =="
for d in "${DIR}" "${DIR}/papers" "${DIR}/cdp"; do
  [ -d "${d}" ] || continue
  for f in "${d}"/*.js; do
    [ -f "${f}" ] || continue
    if node --check "${f}" 2>/tmp/.lint_js_err; then
      say "   OK   $(basename "${f}")"
    else
      echo "   FAIL $(basename "${f}")"
      sed 's/^/        /' /tmp/.lint_js_err
      FAIL=1
    fi
  done
done

# ---------- 2b. python 语法 ----------
say "== 2b. python 语法 (py_compile) =="
for d in "${DIR}" "${DIR}/papers" "${DIR}/cdp"; do
  [ -d "${d}" ] || continue
  for f in "${d}"/*.py; do
    [ -f "${f}" ] || continue
    if python3 -m py_compile "${f}" 2>/tmp/.lint_py_err; then
      say "   OK   $(basename "${f}")"
    else
      echo "   FAIL $(basename "${f}")"
      sed 's/^/        /' /tmp/.lint_py_err
      FAIL=1
    fi
  done
done

# ---------- 3/4. 反模式扫描 ----------
say "== 3. 反模式扫描 =="
python3 - "${DIR}" <<'PY'
import os, re, sys

root = sys.argv[1]
bad = 0

# ---- 反模式 ①: $VAR 紧跟非 ASCII（变量名会被吞掉）----
var_pat = re.compile(r'\$[A-Za-z_][A-Za-z0-9_]*(?=[^\x00-\x7f])')
sh_files = []
for base, _dirs, files in os.walk(root):
    if '/tmp' in base or '/.git' in base:
        continue
    for fn in files:
        if fn.endswith('.sh'):
            sh_files.append(os.path.join(base, fn))

for path in sorted(sh_files):
    for i, line in enumerate(open(path, encoding='utf-8', errors='replace'), 1):
        stripped = line.lstrip()
        if stripped.startswith('#'):          # 注释里的示例无害
            continue
        for m in var_pat.finditer(line):
            if line[max(0, m.start() - 1):m.start() + 1] == '${':
                continue
            print(f"   FAIL {os.path.relpath(path, root)}:{i}  '$VAR' 后面紧跟全角字符: {m.group(0)}")
            print(f"        {line.rstrip()[:120]}")
            print(f'        改法: 写成 "${{{m.group(0)[1:]}}}"')
            bad = 1

# ---- 反模式 ②: JS 模板字符串里的单反斜杠正则类 ----
# 合法转义（在模板串里语义 OK）: \n \t \r \f \v \0 \x \u \\ \` \$
# 其余如 \d \w \s \b \. \/ \- 在模板串里**会丢掉反斜杠**，正则随即失效。
LEGIT = set('ntrfv0xu\\`$\n') | {'\r'}
BAD_CLASS = re.compile(r'(?<!\\)\\([dwsbDWSB./\-+*?^$()\[\]{}|])')
tmpl_files = []
for base, _dirs, files in os.walk(root):
    for fn in files:
        if fn.endswith('.js'):
            tmpl_files.append(os.path.join(base, fn))

for path in sorted(tmpl_files):
    src = open(path, encoding='utf-8', errors='replace').read()
    i = 0
    n = len(src)
    line_no = 1
    while i < n:
        c = src[i]
        if c == '\n':
            line_no += 1
            i += 1
            continue
        # 跳过 // 注释
        if c == '/' and i + 1 < n and src[i + 1] == '/':
            j = src.find('\n', i)
            i = n if j < 0 else j
            continue
        # 跳过 /* */ 注释
        if c == '/' and i + 1 < n and src[i + 1] == '*':
            j = src.find('*/', i + 2)
            if j < 0:
                break
            line_no += src.count('\n', i, j)
            i = j + 2
            continue
        # 跳过普通字符串
        if c in ('"', "'"):
            q = c
            i += 1
            while i < n:
                if src[i] == '\\':
                    i += 2
                    continue
                if src[i] == q:
                    i += 1
                    break
                if src[i] == '\n':
                    line_no += 1
                i += 1
            continue
        # 模板字符串
        if c == '`':
            i += 1
            while i < n:
                if src[i] == '\\':
                    m = BAD_CLASS.match(src, i)
                    if m:
                        ln = line_no + src.count('\n', 0, i) - src.count('\n', 0, 0)
                        seg = src[i:i + 40].replace('\n', '\\n')
                        print(f"   FAIL {os.path.relpath(path, root)} 模板串里出现 '\\{m.group(1)}'（反斜杠会被吃掉）: ...{seg}...")
                        print(f'        改法: 在模板串里要写成 "\\\\{m.group(1)}"')
                        bad = 1
                    i += 2
                    continue
                if src[i] == '`':
                    i += 1
                    break
                if src[i] == '\n':
                    line_no += 1
                i += 1
            continue
        i += 1

if not bad:
    print("   OK   未发现反模式")
sys.exit(bad)
PY
[ $? -ne 0 ] && FAIL=1

echo
if [ "${FAIL}" = "0" ]; then
  echo "== lint 通过 =="
else
  echo "== lint 未通过（见上）==" >&2
fi
exit "${FAIL}"
