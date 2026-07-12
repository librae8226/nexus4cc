#!/usr/bin/env bash
# nexus-restore-tmux.sh — 宕机后由 Nexus 启动时调用，确定性恢复上次 tmux 会话快照。
#
# 为什么需要它（见 docs/SESSION-PERSISTENCE.md §6.1）：
#   tmux-continuum 的开机自动恢复有 `another_tmux_server_running_on_startup` guard，
#   本环境开机时 2×ttyd + PM2/Nexus 同时建 session 会让 tmux 进程数 >1，导致自动恢复被跳过。
#   因此把"恢复"交给 Nexus 启动流程显式触发，确定性强、与"打开 Nexus"动作天然绑定。
#
# 安全保证：
#   - 仅在「全新 tmux 服务器」（无 NEXUS_RESTORED 标记）时恢复一次；标记随服务器生命周期存在，
#     宿主机重启后消失。Nexus 普通重启（tmux 仍在）会因标记存在而跳过，绝不覆盖正在运行的会话。
#   - resurrect restore 本身幂等：已存在的 session/pane 只登记、不重建、不重启其中进程。
set -u

RESURRECT_RESTORE="$HOME/.tmux/plugins/tmux-resurrect/scripts/restore.sh"
RESURRECT_DIR="$HOME/.tmux/resurrect"
SNAPSHOT="$RESURRECT_DIR/last"

# 插件未安装 → 无可恢复，静默成功退出
if [ ! -x "$RESURRECT_RESTORE" ]; then
  echo "[nexus-restore] tmux-resurrect 未安装，跳过"
  exit 0
fi

# 解析快照：last 链接优先。若 last 悬空/缺失（resurrect 并发保存的已知竞态，或宕机打断保存所致），
# 回退到最新的有效快照文件并修复 last——restore.sh 内部读 last，必须保证它有效。
if [ ! -e "$SNAPSHOT" ]; then
  newest="$(ls -t "$RESURRECT_DIR"/tmux_resurrect_*.txt 2>/dev/null | head -1)"
  if [ -z "$newest" ]; then
    echo "[nexus-restore] 无任何有效快照，跳过"
    exit 0
  fi
  echo "[nexus-restore] last 链接悬空，回退到最新有效快照：$(basename "$newest")"
  ln -fs "$(basename "$newest")" "$SNAPSHOT"
fi

# 本 tmux 服务器生命周期内已恢复过 → 跳过（防止 Nexus 普通重启时重复恢复）
if tmux show-environment -g NEXUS_RESTORED >/dev/null 2>&1; then
  echo "[nexus-restore] 本 tmux 服务器已恢复过，跳过"
  exit 0
fi

# 确保有 tmux 服务器供 resurrect 注入（已存在则 no-op）
tmux start-server 2>/dev/null || true

# 标记先行：即使后续恢复失败，也不在同一服务器生命周期内重试（避免覆盖在跑会话）
tmux set-environment -g NEXUS_RESTORED 1 2>/dev/null || true

echo "[nexus-restore] 检测到全新 tmux 服务器，开始恢复上次会话快照…"
# 经 tmux run-shell 调用 restore.sh（而非直接执行）：restore.sh 内部用 $TMUX 推导目标 socket
# （tmux -S "$(echo $TMUX|cut -d, -f1)"）。Nexus 以 execSync 调用本脚本时无 $TMUX，直接执行会
# 因 tmux -S "" 而失败。run-shell 由 tmux 服务器执行命令并注入正确 $TMUX，且前台模式会等待其完成。
if tmux run-shell "$RESURRECT_RESTORE"; then
  echo "[nexus-restore] 结构恢复已完成"
else
  echo "[nexus-restore] 恢复调用返回非零，继续启动" >&2
fi

# 结构恢复只还原 shell + 可见文字，不会重启 claude。再把 Nexus 创建的 claude 频道拉起并接续对话。
sleep 2
RESUME_SCRIPT="$(dirname "$0")/nexus-resume-claude.sh"
if [ -x "$RESUME_SCRIPT" ] || [ -f "$RESUME_SCRIPT" ]; then
  bash "$RESUME_SCRIPT" "$SNAPSHOT" || echo "[nexus-restore] claude 接续步骤返回非零，继续" >&2
fi
exit 0
