#!/usr/bin/env bash
# nexus-restore-tmux.sh — 宕机后恢复 tmux 会话快照。
#
# 两种调用模式：
#   默认（boot） : Nexus 启动时调用。仅在「全新 tmux 服务器」（无 NEXUS_RESTORED 标记）时恢复一次，
#                  并带 start-server 重试，抗 WSL2 启动竞态（见 docs/SESSION-PERSISTENCE.md §6.1/§10）。
#   --manual     : 前端「恢复会话」按钮经 POST /api/restore 调用。跳过标记门与重试（tmux 必然在跑），
#                  幂等重建缺的 session/window 并 resume 对话；结束时打印 RESTORE_OK / RESTORE_ERR 结果行。
#
# 安全保证：
#   - 全程只增不改：resurrect restore.sh 对已存在 session/window 只登记、不重建、不杀进程。
#   - 快照选择器不盲信 last：崩溃后 continuum 可能把 last 覆盖为近空快照（无 nexus-run-claude 频道），
#     选择器始终挑「最新一份含 claude 频道」的快照，近空快照被拒绝（见 spec §4.1）。
set -u

MANUAL=0
[ "${1:-}" = "--manual" ] && MANUAL=1

RESURRECT_RESTORE="$HOME/.tmux/plugins/tmux-resurrect/scripts/restore.sh"
RESURRECT_DIR="$HOME/.tmux/resurrect"
RESUME_SCRIPT="$(cd "$(dirname "$0")" && pwd)/nexus-resume-claude.sh"

log(){ printf '%s\n' "$*"; }
err(){ printf '%s\n' "$*" >&2; }

# 插件未安装 → 无可恢复
if [ ! -x "$RESURRECT_RESTORE" ]; then
  err "[nexus-restore] tmux-resurrect 未安装，跳过"
  [ "$MANUAL" = "1" ] && printf 'RESTORE_ERR tmux-resurrect 未安装\n'
  exit 0
fi

# ── 快照选择器：最新一份含 nexus-run-claude 频道的快照（拒绝崩溃后近空快照）──
SNAPSHOT=""
for f in $(ls -t "$RESURRECT_DIR"/tmux_resurrect_*.txt 2>/dev/null); do
  [ -f "$f" ] || continue
  if grep -q $'^pane\t.*nexus-run-claude\.sh' "$f"; then
    SNAPSHOT="$f"; break
  fi
done
if [ -z "$SNAPSHOT" ]; then
  err "[nexus-restore] 无含 claude 频道的快照，跳过"
  [ "$MANUAL" = "1" ] && printf 'RESTORE_ERR 无含 claude 频道的快照\n'
  exit 0
fi

# 让 restore.sh（内部读 last）指向所选快照
if [ "$(readlink "$RESURRECT_DIR/last" 2>/dev/null || true)" != "$(basename "$SNAPSHOT")" ]; then
  ln -sf "$(basename "$SNAPSHOT")" "$RESURRECT_DIR/last"
fi
log "[nexus-restore] 使用快照：$(basename "$SNAPSHOT")"

# ── boot 模式：标记门 + start-server 重试 ──
if [ "$MANUAL" = "0" ]; then
  if tmux show-environment -g NEXUS_RESTORED >/dev/null 2>&1; then
    log "[nexus-restore] 本 tmux 服务器已恢复过，跳过"
    exit 0
  fi
  server_ready=false
  for i in $(seq 1 10); do
    if tmux start-server 2>/dev/null && tmux has-session 2>/dev/null; then
      server_ready=true; break
    fi
    if tmux info >/dev/null 2>&1; then
      server_ready=true; break
    fi
    sleep 1
  done
  if [ "$server_ready" = false ]; then
    err "[nexus-restore] tmux 服务器启动失败，跳过恢复（将在无历史状态下启动）"
    exit 0
  fi
else
  # ── manual 模式：tmux 必须在跑 ──
  if ! tmux info >/dev/null 2>&1; then
    err "[nexus-restore] tmux 不可用"
    printf 'RESTORE_ERR tmux 不可用\n'
    exit 1
  fi
fi

# 本服务器生命周期内已恢复过 → 不重复（boot 由上面标记门保证；manual 完成后也打标记，
# 避免下次 Nexus 重启时 boot 路径在本服务器上再跑一遍）
tmux set-environment -g NEXUS_RESTORED 1 2>/dev/null || true

# ── 统计恢复前后会话/窗口数（manual 供 RESTORE_OK）──
count_sessions(){ tmux list-sessions 2>/dev/null | wc -l; }
count_windows(){ tmux list-windows -a -F x 2>/dev/null | wc -l; }
s_before="$(count_sessions)"; w_before="$(count_windows)"

log "[nexus-restore] 开始恢复上次会话快照…"
# 经 tmux run-shell 调用 restore.sh（而非直接执行）：restore.sh 内部用 $TMUX 推导目标 socket
# （tmux -S "$(echo $TMUX|cut -d, -f1)"）。Nexus 以 execSync 调用本脚本时无 $TMUX，直接执行会
# 因 tmux -S "" 而失败。run-shell 由 tmux 服务器执行命令并注入正确 $TMUX，且前台模式会等待其完成。
if tmux run-shell "$RESURRECT_RESTORE"; then
  log "[nexus-restore] 结构恢复已完成"
else
  err "[nexus-restore] 恢复调用返回非零，继续启动"
fi

# ── 结构恢复只还原 shell + 可见文字，不会重启 claude。再把 claude 频道拉起并接续对话。──
sleep 2
RESUME_OUT=""
if [ -x "$RESUME_SCRIPT" ] || [ -f "$RESUME_SCRIPT" ]; then
  RESUME_OUT="$(bash "$RESUME_SCRIPT" "$SNAPSHOT" 2>&1 || true)"
  printf '%s\n' "$RESUME_OUT" >&2   # 明细进日志（stdout 保留给 RESTORE_OK）
else
  err "[nexus-restore] 缺 nexus-resume-claude.sh"
fi

if [ "$MANUAL" = "1" ]; then
  s_after="$(count_sessions)"; w_after="$(count_windows)"
  restored_sessions=$(( s_after - s_before )); [ "$restored_sessions" -lt 0 ] && restored_sessions=0
  restored_channels=$(( w_after - w_before )); [ "$restored_channels" -lt 0 ] && restored_channels=0
  resumed="$(printf '%s\n' "$RESUME_OUT" | grep -cE '→ --(resume|continue)' || true)"
  printf 'RESTORE_OK restored_sessions=%d channels=%d resumed=%d snapshot=%s\n' \
    "$restored_sessions" "$restored_channels" "${resumed:-0}" "$(basename "$SNAPSHOT")"
fi
exit 0
