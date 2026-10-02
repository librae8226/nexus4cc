#!/usr/bin/env bash
# tmux-server-supervise.sh — nexus-tmux.service 的 ExecStart：前台守着 tmux server。
#
# 为什么不是 `tmux -D`：man 里 -D 不许带命令，等价于「起一个会话并显示出来」，而 systemd
# 没有 tty → 直接报 `open terminal failed: not a terminal`（2026-10-02 隔离演练实测）。
# 为什么不是 Type=forking + `new-session -d`：那样 systemd 只能猜 MainPID，server 死掉未必
# 触发 Restart= —— 而「server 死了要能自己回来」恰恰是这个 unit 的核心价值。
# 于是：脚本自己起 server（detached，不需要 tty），然后前台盯住它：
#   server 不在 → 非零退出 → Restart=always 把整个 unit 拉回来
#   → ExecStartPost 再触发一次快照恢复 → 会话自动回来。
set -u

TMUX_BIN=/usr/bin/tmux
ZSH_BIN=/usr/bin/zsh
SESS="${TMUX_SESSION:-main}"

if ! "$TMUX_BIN" show-environment -g >/dev/null 2>&1; then
  if ! "$TMUX_BIN" new-session -d -s "$SESS" -n shell -c "$HOME" "$ZSH_BIN" >/dev/null 2>&1; then
    echo "[tmux-supervise] 起 tmux server 失败（socket 目录不可用？看 ExecStartPre）" >&2
    exit 1
  fi
  echo "[tmux-supervise] 已起 tmux server（session $SESS）"
else
  echo "[tmux-supervise] tmux server 已在跑，接管监视"
fi

while "$TMUX_BIN" show-environment -g >/dev/null 2>&1; do
  sleep 2
done

echo "[tmux-supervise] tmux server 不在了 → 非零退出，交给 systemd Restart=always" >&2
exit 1
