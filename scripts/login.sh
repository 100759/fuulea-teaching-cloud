#!/bin/bash
# 登录 智慧教学云（支持多站点）
#
# 用法:
#   bash login.sh            # 默认登录 test（测试站）
#   bash login.sh lyyz       # 登录 lyyz（生产站，真实师生数据）
#   bash login.sh test 4     # 登录后额外等待秒数（弱网时用，默认 7）
#
# 凭据来源（按优先级）:
#   1. 环境变量 FUULEA_ACCOUNT / FUULEA_PASSWORD
#   2. 同目录 .credentials（格式 别名|账号|密码，建议 chmod 600）
#
# 安全: 生产站(tier=prod)只做登录，不代表允许任何写操作。
#       写操作前必须先读 SKILL.md 的「站点分级与安全策略」。

set -u
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

DIR="$(cd "$(dirname "$0")" && pwd)"
ALIAS="${1:-test}"
WAIT="${2:-7}"

# ---- 浏览器会话 ----
# 统一走 browser.sh：会话命名 + "开完必须确认真的渲染出来" + 坏状态自动硬重置。
# ⚠️ 不用 agent-browser 的默认会话 `default`（全机共享，会被别的 agent 抢页面）。
#    详细根因见 browser.sh 头部注释。
. "$DIR/browser.sh" 2>/dev/null || true
export AGENT_BROWSER_SESSION="$(session_name "$ALIAS")"

# ---- 站点注册表 ----
LINE=$(grep -E "^${ALIAS}\|" "$DIR/sites.conf" 2>/dev/null | head -1)
if [ -z "${LINE:-}" ]; then
  echo "LOGIN_FAIL: 未知站点别名 '$ALIAS'。可用别名见 $DIR/sites.conf" >&2
  exit 2
fi
BASE=$(printf '%s' "$LINE" | cut -d'|' -f2)
TIER=$(printf '%s' "$LINE" | cut -d'|' -f3)
DESC=$(printf '%s' "$LINE" | cut -d'|' -f4)

# ---- 凭据 ----
ACCOUNT="${FUULEA_ACCOUNT:-}"
PASSWORD="${FUULEA_PASSWORD:-}"
if [ -z "$ACCOUNT" ] && [ -f "$DIR/.credentials" ]; then
  CRED=$(grep -E "^${ALIAS}\|" "$DIR/.credentials" 2>/dev/null | head -1)
  if [ -n "${CRED:-}" ]; then
    ACCOUNT=$(printf '%s' "$CRED" | cut -d'|' -f2)
    PASSWORD=$(printf '%s' "$CRED" | cut -d'|' -f3)
  fi
fi
if [ -z "$ACCOUNT" ] || [ -z "$PASSWORD" ]; then
  echo "LOGIN_FAIL: 站点 '$ALIAS' 没有可用凭据。" >&2
  echo "  请在 $DIR/.credentials 加一行: ${ALIAS}|账号|密码   (然后 chmod 600)" >&2
  echo "  或设置环境变量 FUULEA_ACCOUNT / FUULEA_PASSWORD" >&2
  exit 3
fi

echo "站点: $ALIAS  ($BASE)  等级: $TIER  — $DESC"
if [ "$TIER" = "prod" ]; then
  echo "注意: 这是生产站。本次仅登录，不做任何写操作。"
fi

# ---- 打开首页；已登录则复用会话 ----
# 冷启动（close 之后首次拉起 Chromium）可能要十几秒才渲染完，所以轮询等待；
# open 已回 ✓ 但页面是 about:blank 时，open_checked 会自动硬重置会话再试。
T=""
READY=""
for attempt in 1 2 3; do
  open_checked "$BASE/" || true
  for i in 1 2 3 4 5 6; do
    sleep 3
    T=$(agent-browser read 2>/dev/null || true)
    if printf '%s' "$T" | grep -q '题库'; then
      echo "LOGIN_OK  ($ALIAS 已登录，复用会话)"
      exit 0
    fi
    if printf '%s' "$T" | grep -q '账号登录'; then
      READY="yes"; break
    fi
  done
  [ -n "$READY" ] && break
  echo "  (第 ${attempt} 次未渲染出登录页；URL=$(agent-browser get url 2>/dev/null))" >&2
done

if [ -z "$READY" ]; then
  echo "LOGIN_FAIL: 页面未渲染出登录入口（重试 3 次仍超时）。" >&2
  echo "  会话: $AGENT_BROWSER_SESSION   当前 URL: $(agent-browser get url 2>/dev/null)" >&2
  echo "  URL 为 about:blank 即会话状态坏了，硬重置：bash $DIR/browser.sh hard-reset" >&2
  echo "  仍不行就全清：                 bash $DIR/browser.sh hard-reset --all" >&2
  exit 1
fi

# ---- 切到「账号登录」tab（默认是扫码登录） ----
REF=$(agent-browser snapshot -i 2>/dev/null | grep '账号登录' | grep -oE 'e[0-9]+' | head -1)
if [ -n "${REF:-}" ]; then
  agent-browser click "@$REF" >/dev/null 2>&1
  sleep 2
fi

# ---- 取 ref（必须在同一批 snapshot 内，ref 会随重渲染失效） ----
SNAP=""
for i in 1 2 3; do
  SNAP=$(agent-browser snapshot -i 2>/dev/null)
  if printf '%s' "$SNAP" | grep -q '请输入账号名'; then break; fi
  sleep 2
done
U=$(printf '%s' "$SNAP" | grep '请输入账号名' | grep -oE 'e[0-9]+' | head -1)
P=$(printf '%s' "$SNAP" | grep '请输入密码'   | grep -oE 'e[0-9]+' | head -1)
B=$(printf '%s' "$SNAP" | grep -E 'button "登录"' | grep -oE 'e[0-9]+' | head -1)

if [ -z "${U:-}" ] || [ -z "${P:-}" ] || [ -z "${B:-}" ]; then
  echo "LOGIN_FAIL: 未找到账号/密码/登录按钮，当前页面快照：" >&2
  printf '%s\n' "$SNAP" >&2
  exit 1
fi

agent-browser fill "@$U" "$ACCOUNT"  >/dev/null 2>&1
agent-browser fill "@$P" "$PASSWORD" >/dev/null 2>&1
sleep 1
agent-browser click "@$B" >/dev/null 2>&1
sleep "$WAIT"

# ---- 验活 ----
if agent-browser read 2>/dev/null | grep -q '题库'; then
  echo "LOGIN_OK  site=$ALIAS  account=$ACCOUNT"
  exit 0
else
  echo "LOGIN_FAIL: 未进入主界面（密码错误 / 账号不存在 / 页面异常）。" >&2
  echo "  排查: agent-browser console   以及   agent-browser read" >&2
  exit 1
fi
