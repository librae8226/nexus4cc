#!/usr/bin/env bash
# tmux-server-ready.sh — nexus-tmux.service 的 ExecStartPost。
#
# 三件事，顺序不能变：
#   1. 等 server 真的能应答（ExecStart 是 Type=exec，execve 成功 ≠ socket 能连）
#   2. 保证默认 session（main）存在 —— 服务器空着就没有任何会话，UI 一进来是空面板
#   3. **后台**拉开快照恢复：恢复要跑 resurrect + 逐个接续 claude，可能要几十秒，
#      绝不能阻塞 unit 激活（Before=pm2-librae.service 会把这段延迟转嫁给 wechat-agent）。
#
# 失败即 exit 1：unit 记 failed（Restart=always 会重试，StartLimitBurst 防热循环），
# Nexus 那边看到 tmux 不可用会进救援模式 —— 不会再有「安静地少了一半会话」。
set -u

TMUX_BIN=/usr/bin/tmux
ZSH_BIN=/usr/bin/zsh
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/.." && pwd)"
LOG="$REPO/logs/tmux-restore.log"
SESS="${TMUX_SESSION:-main}"

mkdir -p "$REPO/logs" 2>/dev/null || true
log(){ printf '%s [tmux-ready] %s\n' "$(date -Is)" "$*" >>"$LOG"; }

# 1) 等就绪（最多 30s）
ready=0
for _ in $(seq 1 60); do
  if "$TMUX_BIN" show-environment -g >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
if [ "$ready" != 1 ]; then
  log "server 30s 内未就绪，放弃（unit 记 failed）"
  exit 1
fi

# 2) 保证默认 session 存在（空服务器 / main 被误删时兜底）
if ! "$TMUX_BIN" has-session -t "$SESS" 2>/dev/null; then
  "$TMUX_BIN" new-session -d -s "$SESS" -n shell -c "$HOME" "$ZSH_BIN" >>"$LOG" 2>&1 || true
  log "创建默认 session '$SESS'"
fi

# 3) 后台恢复（幂等：快照里的 session 都在跑时脚本自己会退出）
log "启动恢复（后台，detached）"
setsid --fork bash "$DIR/nexus-restore-tmux.sh" >>"$LOG" 2>&1 </dev/null
exit 0
