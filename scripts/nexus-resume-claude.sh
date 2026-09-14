#!/usr/bin/env bash
# nexus-resume-claude.sh — 恢复 tmux 结构后，重新拉起 Nexus 创建的 claude 频道并精确接续对话。
#
# 背景：tmux-resurrect 只还原 shell + 可见文字，不会重启 claude 进程。本脚本：
#   1. 解析 resurrect 快照里每个 pane 的标题和启动命令
#   2. 用 Python 模糊匹配 pane 标题 ↔ ~/.claude/projects/**/*.jsonl 的第一条用户消息
#   3. 匹配成功 → claude --resume <session-id>（精确接续该条对话）
#   4. 匹配失败 → claude --continue（回退到最近一条对话）
#
# 用法: nexus-resume-claude.sh [--dry-run] <snapshot_file> [skip_pane]
#   --dry-run: 只打印匹配结果，不实际发送任何按键
#   skip_pane: 形如 session:window.pane，手动恢复时跳过调用方自身 pane（避免自杀）。
#
# 安全：只对当前是普通 shell 的 pane 注入，不覆盖已在跑 claude 的 pane；逐个错峰拉起。
set -u

DRY_RUN=false
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true; shift
fi

SNAP="${1:-}"
SKIP_PANE="${2:-}"

if [ -z "$SNAP" ] || [ ! -e "$SNAP" ]; then
  echo "[nexus-resume] 快照不存在（$SNAP），跳过"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Phase 1: 模糊匹配 pane 标题 → conversation session ID ──
# 匹配逻辑在 scripts/nexus-match-panes.js（node），不再内联 python3：
# macOS 自 Mojave 起不再自带 python3，最小化 Debian 也没有，而 node 一定在。
# 输出格式（每行）: session:window.pane|resume_arg|score|title
#   resume_arg = <session-uuid>  → 精确匹配，用 --resume <id>
#   resume_arg = CONTINUE        → 无匹配，回退 --continue
NODE_BIN="${NEXUS_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "[nexus-resume] 未找到 node，跳过（解析快照需要 node）"
  exit 0
fi

# 不把 stderr 并进 MATCHES：匹配器报错时安静回落到「无可接续的 pane」，
# 而不是让错误文本被当成匹配结果解析。
MATCHES=$("$NODE_BIN" "$SCRIPT_DIR/nexus-match-panes.js" "$SNAP")

if [ -z "$MATCHES" ]; then
  echo "[nexus-resume] 无可接续的 pane"
  exit 0
fi

# ── Phase 2: 向每个 pane 注入对应的 claude 启动命令 ──
echo "$MATCHES" | while IFS='|' read -r target resume_arg score pane_title; do
  if [ -n "$SKIP_PANE" ] && [ "$target" = "$SKIP_PANE" ]; then
    echo "[nexus-resume] 跳过调用方自身 pane $target"
    continue
  fi

  sess="${target%:*.*}"
  rest="${target#*:}"
  win="${rest%.*}"
  pidx="${rest#*.}"

  # 目标 pane 必须存在且在跑普通 shell
  if ! tmux has-session -t "$sess" 2>/dev/null; then
    echo "[nexus-resume] session '$sess' 不存在，跳过 $target"
    continue
  fi
  cur="$(tmux display-message -p -t "$target" '#{pane_current_command}' 2>/dev/null)" || continue
  case "$cur" in
    zsh|bash|sh|-zsh|-bash|fish) ;;
    *) echo "[nexus-resume] $target 已在跑 '$cur'，跳过"; continue ;;
  esac

  # pane_current_command 会把「nexus-run-claude.sh(bash 包装) + claude 子进程」误报为 bash，
  # 但 claude 才是该 pane 的前台进程。若 pane 进程树下已在跑 claude，视为「已在跑 claude」跳过，
  # 避免把 NEXUS_RESUME_SESSION=... 打进正在运行的 claude 输入。
  pane_pid="$(tmux display-message -p -t "$target" '#{pane_pid}' 2>/dev/null || true)"
  if [ -n "$pane_pid" ] && ps -ax -o ppid=,args= 2>/dev/null | awk -v p="$pane_pid" '$1 == p' | grep -qE '(^|/)claude([[:space:]]|$)|nexus-run-claude'; then
    echo "[nexus-resume] $target 进程树下已在跑 claude，跳过"
    continue
  fi

  # 安全校验：对比快照中的 window name 与当前 window name。
  # 若不同（例如用户在该 index 新建了窗口），跳过——避免把对话注入到错误的窗口。
  snap_win_name="$(awk -F'\t' -v s="$sess" -v w="$win" '$1=="window" && $2==s && $3==w {print $4; exit}' "$SNAP" | sed 's/^://;s/^-//')"
  cur_win_name="$(tmux display-message -p -t "$sess:$win" '#{window_name}' 2>/dev/null)"
  if [ -n "$snap_win_name" ] && [ -n "$cur_win_name" ] && [ "$snap_win_name" != "$cur_win_name" ]; then
    echo "[nexus-resume] $target window 名不匹配（快照='$snap_win_name' 当前='$cur_win_name'），跳过"
    continue
  fi

  # 从快照提取该 pane 的完整启动命令
  pfull="$(awk -F'\t' -v s="$sess" -v w="$win" '$1=="pane" && $2==s && $3==w {print $11; exit}' "$SNAP" | sed 's/^://')"
  if [ -z "$pfull" ]; then
    echo "[nexus-resume] 未找到 $target 的启动命令，跳过"
    continue
  fi

  if [ "$resume_arg" = "CONTINUE" ]; then
    if $DRY_RUN; then
      echo "[DRY-RUN] $target ($pane_title) → --continue"
    else
      echo "[nexus-resume] $target ($pane_title) → --continue (score=$score)"
      tmux send-keys -t "$target" "NEXUS_RESUME=1 $pfull" C-m
    fi
  else
    if $DRY_RUN; then
      echo "[DRY-RUN] $target ($pane_title) → --resume $resume_arg"
    else
      echo "[nexus-resume] $target ($pane_title) → --resume $resume_arg (score=$score)"
      tmux send-keys -t "$target" "NEXUS_RESUME_SESSION=$resume_arg $pfull" C-m
    fi
  fi
  $DRY_RUN || sleep 1
done

echo "[nexus-resume] done"
