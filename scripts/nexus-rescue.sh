#!/usr/bin/env bash
# nexus-rescue.sh — break-glass 救援，**零 root 权限**。
#
# 用在 Nexus 进了救援模式（tmux 不可用 / 会话没恢复回来）的时候。它做四件事：
#   1. 补 socket 目录（/tmp 是 tmpfs，开机后被清空的经典故障点）
#   2. server 不在就手起一个默认 session（正常路径由 nexus-tmux.service 负责，
#      这里是「unit 也没起来」时的断线钳）
#   3. 跑一次手动恢复（幂等，只补缺的 session/channel，接续 claude 对话）
#   4. 打印诊断：服务器状态、缺哪些 session、unit 状态、最新快照、claude 进程数
#
# 救援 agent 的第一件事就是跑这个脚本，然后按输出处置。
# 演练：NEXUS_RESCUE_TMPDIR=/tmp/xxx bash scripts/nexus-rescue.sh（不碰线上 socket）
set -u

ROOT="${NEXUS_RESCUE_TMPDIR:-${TMPDIR:-/tmp}}"
DIR="$(cd "$(dirname "$0")" && pwd)"
SOCK_DIR="$ROOT/tmux-$(id -u)"
SESS="${TMUX_SESSION:-main}"

echo "== nexus-rescue $(date -Is)（socket 根：$ROOT）=="

# 1) socket 目录
if mkdir -p "$SOCK_DIR" 2>/dev/null && chmod 700 "$SOCK_DIR" 2>/dev/null; then
  echo "[1/4] socket 目录就绪：$SOCK_DIR"
else
  echo "[1/4] ⚠ socket 目录不可用：$SOCK_DIR（若被 root 占着：sudo rm -rf $SOCK_DIR）"
fi

# 2) server
if TMPDIR="$ROOT" tmux show-environment -g >/dev/null 2>&1; then
  echo "[2/4] tmux server 已在跑，无需新建"
else
  TMPDIR="$ROOT" tmux new-session -d -s "$SESS" -n shell -c "$HOME" /usr/bin/zsh >/dev/null 2>&1 || true
  if TMPDIR="$ROOT" tmux show-environment -g >/dev/null 2>&1; then
    echo "[2/4] tmux server 已拉起（session $SESS）"
  else
    echo "[2/4] ⚠ server 仍不可用 —— 看 'systemctl status nexus-tmux' 与 journalctl -u nexus-tmux"
  fi
fi

# 3) 手动恢复
echo "[3/4] 跑一次手动恢复…"
TMPDIR="$ROOT" bash "$DIR/nexus-restore-tmux.sh" --manual 2>&1 | sed 's/^/      /'

# 4) 诊断
echo "[4/4] 诊断："
TMPDIR="$ROOT" tmux list-sessions 2>&1 | sed 's/^/      /'
echo "      unit：$(systemctl is-active nexus-tmux 2>&1)（enabled: $(systemctl is-enabled nexus-tmux 2>&1)）"
echo "      最新快照：$(ls -t "$HOME"/.tmux/resurrect/tmux_resurrect_*.txt 2>/dev/null | head -1)"
echo "      claude 进程数：$(pgrep -c -f 'claude --' 2>/dev/null || echo 0)"
echo "== 结束：若上面有 ⚠ / RESCUE_ERR / 恢复失败，按 docs/SESSION-PERSISTENCE.md 的救援一节处置 =="
