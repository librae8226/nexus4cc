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

# 快照里有多少个 claude 频道（= 期望值）
channels_in_snapshot(){ awk -F'\t' '$1=="pane" && $11 ~ /nexus-run-claude\.sh/ {n++} END{print n+0}' "$SNAPSHOT"; }
# 线上有多少个 pane 的进程树下跑着 claude / nexus-run-claude（= 实际值）
count_live_channels(){
  local n=0 pid
  for pid in $(tmux list-panes -a -F '#{pane_pid}' 2>/dev/null); do
    ps -ax -o ppid=,args= 2>/dev/null | awk -v p="$pid" '$1 == p' \
      | grep -qE '(^|/)claude([[:space:]]|$)|nexus-run-claude' && n=$((n+1))
  done
  echo "$n"
}

# ── 结果闭环：别只说「结构恢复完成」，要核对真的恢复了 ──
# 与 server.js 的审计同格式，面板「操作日志」里能一起看到。
audit_append(){
  mkdir -p "$HOME/work/nexus/data" 2>/dev/null || true
  printf '{"ts":"%s","action":"%s","source":"restore-script"%s}\n' \
    "$(date -Is)" "$1" "${2:+,$2}" >> "$HOME/work/nexus/data/audit.log" 2>/dev/null || true
}
notify_wechat(){
  local p="$HOME/work/wechat-agent/push.mjs"
  [ -f "$p" ] && node "$p" "【nexus】$1" >/dev/null 2>&1 || true
}

# claude 频道要经本机 mihomo（HTTP_PROXY=127.0.0.1:7890）出网。开机时 tmux unit 排在 pm2
# 之前，代理可能还没起来 —— 不等就接续，claude 首次请求会直接失败、pane 掉回 zsh。
wait_proxy(){
  local i
  for i in $(seq 1 30); do
    (exec 3<>/dev/tcp/127.0.0.1/7890) 2>/dev/null && { exec 3>&-; return 0; }
    sleep 2
  done
  return 1
}

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
run_resume(){
  if [ "${NEXUS_RESTORE_DRY_RUN:-0}" = "1" ]; then
    bash "$RESUME_SCRIPT" --dry-run "$SNAPSHOT" 2>&1 || true
  else
    bash "$RESUME_SCRIPT" "$SNAPSHOT" 2>&1 || true
  fi
}

RESUME_OUT=""
if [ -f "$RESUME_SCRIPT" ]; then
  [ "${NEXUS_RESTORE_DRY_RUN:-0}" != "1" ] && { wait_proxy && log "[nexus-restore] 代理已就绪" || err "[nexus-restore] 代理 60s 未就绪，仍尝试接续（claude 可能首请求失败）"; }
  RESUME_OUT="$(run_resume)"
  printf '%s\n' "$RESUME_OUT" >&2
  # 一次都没接上、但快照里确实有频道 → 大概率是 session 瞬时不可见的竞态，隔几秒重试一次
  if [ "${NEXUS_RESTORE_DRY_RUN:-0}" != "1" ] \
     && [ "$(printf '%s\n' "$RESUME_OUT" | grep -cE '→ --(resume|continue)')" = "0" ] \
     && [ "$(channels_in_snapshot)" -gt 0 ]; then
    log "[nexus-restore] 首次接续 0 个频道，5s 后重试一次"
    sleep 5
    RESUME_OUT="$RESUME_OUT$(printf '\n%s' "$(run_resume)")"
    printf '%s\n' "$RESUME_OUT" >&2
  fi
else
  err "[nexus-restore] 缺 nexus-resume-claude.sh"
fi

# ── 闭环核对：session 是否齐了、频道是否真的起来了 ──
miss_after="$(missing_sessions)"
want_channels="$(channels_in_snapshot)"
have_channels="$(count_live_channels)"
log "[nexus-restore] 核对：session 缺 $miss_after / 频道 $have_channels 在跑（快照期望 $want_channels）"
if [ "$miss_after" != "0" ] || { [ "$want_channels" -gt 0 ] && [ "$have_channels" -lt "$want_channels" ]; }; then
  err "[nexus-restore] ⚠ 恢复不完整：缺 $miss_after session，频道 $have_channels/$want_channels"
  audit_append restore-incomplete "\"missingSessions\":$miss_after,\"channels\":$have_channels,\"want\":$want_channels,\"snapshot\":\"$(basename "$SNAPSHOT")\""
  [ "${NEXUS_RESTORE_DRY_RUN:-0}" != "1" ] && notify_wechat "开机恢复不完整：缺 $miss_after 个 session、频道 $have_channels/$want_channels。打开面板 → 救援终端（或点「恢复会话」）。"
else
  audit_append restore-ok "\"missingSessions\":0,\"channels\":$have_channels,\"snapshot\":\"$(basename "$SNAPSHOT")\""
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
