#!/bin/bash
# 浏览器会话公共层 —— 被 login.sh / bind_paper.sh / exam_papers.sh source
# 也可直接调用: bash browser.sh <子命令> [参数]
#
# 子命令:
#   session <别名>            打印该站点用的会话名
#   hard-reset [--all]        **彻底**重置浏览器会话（见下）
#   open-checked <url> [sel]  打开 URL 并确认真的渲染出来了，失败自动硬重置重试
#
# ---------------------------------------------------------------------------
# 为什么需要 hard-reset（踩过的坑，别删）
#
# 现象：`agent-browser open <url>` 明明回 ✓，但 `get url` / `tab` 永远返回
#       `about:blank`，页面渲染不出来；`read`/`eval` 拿到空 body。
#       伴随 `console` 却能打印出目标站的日志（说明有两个"当前页"在打架）。
#       此时 login.sh 会 3 次重试全超时。
#
# 排查结论：**不是**会话名的问题（连字符/下划线/前缀都试过，无关），
#           而是 `~/.agent-browser/` 下的会话状态文件坏了、且 `close --all`
#           **清不掉**（它报 "✓ Closed session: X"，但 X 仍在 session list 里）。
#           同一会话名反复重试只会一直命中那份坏状态，换名字才会"好"。
#
# 解法：close --all + 杀掉残留守护进程(pid 文件) + **删掉会话状态文件**，
#       再重新 open。实测做完这一步，原本"怎么都不行"的会话名立刻恢复正常。
#
# 注意：只删 `~/.agent-browser/` 下**该会话**的状态文件，
#       不动 `browsers/`（浏览器二进制缓存）和 `tmp/`。
# ---------------------------------------------------------------------------
set -u
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

AB_STATE="${AGENT_BROWSER_STATE_DIR:-$HOME/.agent-browser}"

session_name() { printf 'fuulea-%s' "${1:-default}"; }

# 彻底重置：关会话 -> 杀守护进程 -> 删状态文件
#   hard-reset            只清当前 AGENT_BROWSER_SESSION（及 fuulea-* 遗留）
#   hard-reset --all      清掉 agent-browser 下所有会话状态
hard_reset() {
  local scope="${1:-mine}"
  local sess="${AGENT_BROWSER_SESSION:-}"
  echo "  [hard-reset] close --all" >&2
  agent-browser close --all >/dev/null 2>&1 || true
  sleep 2

  local f base p
  for f in "$AB_STATE"/*; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    case "$base" in
      browsers|tmp) continue;;
    esac
    if [ "$scope" != "all" ]; then
      # 只清本会话 + fuulea-* 遗留，绝不误伤别的 agent 的会话
      case "$base" in
        "${sess}".*) ;;
        fuulea-*|fuulea_*) ;;
        *) continue;;
      esac
    fi
    case "$base" in
      *.pid)
        p="$(cat "$f" 2>/dev/null || true)"
        if [ -n "${p:-}" ]; then
          kill -TERM "$p" 2>/dev/null && echo "  [hard-reset] killed $base pid=$p" >&2
        fi
        ;;
    esac
    rm -f "$f"
  done
  sleep 1
  echo "  [hard-reset] done (scope=$scope)" >&2
}

# 打开 URL 并**确认真的渲染出来**（不是 about:blank、body 非空、可选选择器存在）。
# 失败 -> hard_reset 后重试。成功返回 0。
open_checked() {
  local url="$1" sel="${2:-}" tries="${3:-3}"
  local sess="${AGENT_BROWSER_SESSION:-}"
  local i k cur len n
  for i in $(seq 1 "$tries"); do
    agent-browser open "$url" >/dev/null 2>&1 || true
    for k in 1 2 3 4 5 6; do
      sleep 2
      cur="$(agent-browser get url 2>/dev/null || true)"
      case "$cur" in ''|about:blank) continue;; esac
      len="$(agent-browser eval 'document.body?document.body.innerText.length:0' 2>/dev/null | tr -d '"' || true)"
      case "$len" in ''|*[!0-9]*) continue;; esac
      [ "$len" -gt 0 ] || continue
      if [ -n "$sel" ]; then
        n="$(agent-browser eval "document.querySelectorAll(${sel}).length" 2>/dev/null | tr -d '"' || true)"
        case "$n" in ''|*[!0-9]*) continue;; esac
        [ "$n" -gt 0 ] || continue
      fi
      return 0
    done
    echo "  (第 ${i} 次打开未渲染成功；URL=$(agent-browser get url 2>/dev/null))" >&2
    hard_reset mine
    agent-browser --session "$sess" open "$url" >/dev/null 2>&1 || true
  done
  return 1
}

# 直接调用入口（被 source 时跳过，否则会误吃调用方自己的参数）
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  case "${1:-}" in
    session)      session_name "${2:-default}"; echo;;
    hard-reset)   hard_reset "${2:-mine}";;
    open-checked) shift; open_checked "$@";;
    '')           sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//';;
    *)            echo "未知子命令 '$1'（见 browser.sh 头部用法）" >&2; exit 2;;
  esac
fi
