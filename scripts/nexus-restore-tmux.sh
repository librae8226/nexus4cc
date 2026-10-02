#!/usr/bin/env bash
# nexus-restore-tmux.sh — 把最近一份健康快照里的 session / channel 恢复到当前 tmux 服务器。
#
# 谁调用（权威只有一个：**当前服务器缺什么就补什么**）：
#   · nexus-tmux.service 的 ExecStartPost → 服务器（重）启动后自动恢复
#     （机器重启走这条路；中途 server 意外死亡、systemd 拉起后同样会走）
#   · 前端「恢复会话」按钮 → POST /api/restore → `--manual`
#   · 人工 / 救援 agent → `bash scripts/nexus-restore-tmux.sh --manual`
#
# 不变量：**只增不改**。resurrect 的 restore.sh 对已存在的 session/window 只登记、不重建、
# 不杀进程；本脚本只补「快照里有、线上没有」的那部分，缺 0 个就直接返回。
#
# 环境变量：
#   NEXUS_RESTORE_DRY_RUN=1  只做结构恢复，接续 claude 的按键不发（内部走 --dry-run）
#   TMPDIR / TMUX_TMPDIR     演练时可指向临时目录（默认 /tmp/tmux-$(id -u)）
set -u

MANUAL=0
[ "${1:-}" = "--manual" ] && MANUAL=1

RESURRECT_RESTORE="$HOME/.tmux/plugins/tmux-resurrect/scripts/restore.sh"
RESURRECT_DIR="$HOME/.tmux/resurrect"
RESUME_SCRIPT="$(cd "$(dirname "$0")" && pwd)/nexus-resume-claude.sh"

log(){ printf '%s\n' "$*"; }
err(){ printf '%s\n' "$*" >&2; }

# tmux 必须先能用。socket 目录由 nexus-tmux.service 的 ExecStartPre 保证，这里不做兜底补丁；
# 只把失败说清楚，交给 Nexus 的救援模式处置。
if ! tmux show-environment -g >/dev/null 2>&1; then
  err "[nexus-restore] tmux 不可用（server 未就绪）"
  [ "$MANUAL" = "1" ] && printf 'RESTORE_ERR tmux 不可用\n'
  exit 1
fi

if [ ! -x "$RESURRECT_RESTORE" ]; then
  err "[nexus-restore] tmux-resurrect 未安装，跳过"
  [ "$MANUAL" = "1" ] && printf 'RESTORE_ERR tmux-resurrect 未安装\n'
  exit 0
fi

# ── 快照选择器：优先「健康」快照（≥2 条 claude 频道），退而取最新含频道的一份 ──
# 不能只按「含一条频道」筛：崩溃后重建的 main 里就有 claude，continuum 随即存下只含这
# 一条频道的近空快照，它会压过哪怕一分钟前还完好的多 session 快照（快照退化棘轮）。
SNAPSHOT=""; FALLBACK=""
for f in $(ls -t "$RESURRECT_DIR"/tmux_resurrect_*.txt 2>/dev/null); do
  [ -f "$f" ] || continue
  n="$(grep -c $'^pane\t.*nexus-run-claude\.sh' "$f" 2>/dev/null || true)"
  [ "${n:-0}" -eq 0 ] && continue
  [ -z "$FALLBACK" ] && FALLBACK="$f"
  if [ "${n:-0}" -ge 2 ]; then SNAPSHOT="$f"; break; fi
done
[ -z "$SNAPSHOT" ] && SNAPSHOT="$FALLBACK"

if [ -z "$SNAPSHOT" ]; then
  err "[nexus-restore] 没有含 claude 频道的快照，跳过"
  [ "$MANUAL" = "1" ] && printf 'RESTORE_ERR 无含 claude 频道的快照\n'
  exit 0
fi

# restore.sh 内部读 last 链接，先把它指向选中的快照
if [ "$(readlink "$RESURRECT_DIR/last" 2>/dev/null || true)" != "$(basename "$SNAPSHOT")" ]; then
  ln -sf "$(basename "$SNAPSHOT")" "$RESURRECT_DIR/last"
fi

# 快照里还有多少 session 不在当前服务器上（缺 = 要恢复）
# 注意用 awk 而不是 grep '\t'：GNU grep 的 BRE/ERE 不展开 \t，那种写法会永远匹配不到
# （旧版脚本就是这么静默返回 0 的）。
missing_sessions(){
  local sess missing=0
  for sess in $(awk -F'\t' '$1=="window"{print $2}' "$SNAPSHOT" 2>/dev/null | sort -u); do
    tmux has-session -t "$sess" 2>/dev/null || missing=$((missing+1))
  done
  echo "$missing"
}

count_sessions(){ tmux list-sessions 2>/dev/null | wc -l; }
count_windows(){ tmux list-windows -a -F x 2>/dev/null | wc -l; }

s_before="$(count_sessions)"; w_before="$(count_windows)"
missing="$(missing_sessions)"

if [ "$missing" = "0" ]; then
  log "[nexus-restore] 快照里的 session 都在跑，无需恢复（快照 $(basename "$SNAPSHOT")）"
  [ "$MANUAL" = "1" ] && printf 'RESTORE_OK restored_sessions=0 channels=0 resumed=0 snapshot=%s\n' "$(basename "$SNAPSHOT")"
  exit 0
fi

log "[nexus-restore] 快照 $(basename "$SNAPSHOT")：缺 $missing 个 session，开始恢复…"

# 经 tmux run-shell 调 restore.sh：restore.sh 用 $TMUX 推导目标 socket，run-shell 由服务器
# 执行命令并注入正确的 $TMUX（直接 exec 会因 $TMUX 为空而失败）。
if tmux run-shell "$RESURRECT_RESTORE"; then
  log "[nexus-restore] 结构恢复完成"
else
  err "[nexus-restore] 结构恢复调用返回非零，继续"
fi

# 结构恢复只还原 shell + 可见文字，不会重启 claude：再把 claude 频道接续起来。
sleep 2
RESUME_OUT=""
if [ -f "$RESUME_SCRIPT" ]; then
  if [ "${NEXUS_RESTORE_DRY_RUN:-0}" = "1" ]; then
    log "[nexus-restore] DRY-RUN：不发送任何按键"
    RESUME_OUT="$(bash "$RESUME_SCRIPT" --dry-run "$SNAPSHOT" 2>&1 || true)"
  else
    RESUME_OUT="$(bash "$RESUME_SCRIPT" "$SNAPSHOT" 2>&1 || true)"
  fi
  printf '%s\n' "$RESUME_OUT" >&2
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
