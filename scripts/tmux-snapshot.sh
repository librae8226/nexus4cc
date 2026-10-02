#!/usr/bin/env bash
# tmux-snapshot.sh — 独立于客户端的快照触发器（由 nexus-tmux-snapshot.timer 每 5 分钟调用）。
#
# 为什么要它：tmux-resurrect/continuum 的「每 5 分钟自动保存」挂在 status-right 上，靠状态栏
# 重绘触发 —— 客户端不活跃/长时间没人看就不存。2026-10-02 实测快照时间线出现过
# 13:37→13:47、14:03→15:08（65 分钟）的空档，等于「宕机后恢复到一小时前的结构」。
# 这个 timer 让保存与有没有人看无关。
#
# 顺带做两件事：
#   1. last 悬空自愈（resurrect 并发保存竞态会留下悬空链接，见 docs/SESSION-PERSISTENCE.md §6）
#   2. 陈旧检测：保存完最新快照仍太旧 → 以非零退出，让 journalctl 上能看见
set -u

SAVE="$HOME/.tmux/plugins/tmux-resurrect/scripts/save.sh"
DIR="$HOME/.tmux/resurrect"
STALE_SECONDS=720   # 12 分钟（正常应 ≤5 分钟）就算链路坏了

[ -x "$SAVE" ] || { echo "tmux-resurrect 未安装（$SAVE）"; exit 1; }
if ! tmux show-environment -g >/dev/null 2>&1; then
  echo "tmux server 不在，跳过（unit nexus-tmux 应该在跑）"
  exit 1
fi

tmux run-shell "$SAVE"

# last 悬空自愈
target="$(readlink "$DIR/last" 2>/dev/null || true)"
if [ -z "$target" ] || [ ! -e "$DIR/$target" ]; then
  newest="$(ls -t "$DIR"/tmux_resurrect_*.txt 2>/dev/null | head -1)"
  if [ -n "$newest" ]; then
    ln -sf "$(basename "$newest")" "$DIR/last"
    echo "last 悬空 → 修复为 $(basename "$newest")"
  fi
fi

newest="$(ls -t "$DIR"/tmux_resurrect_*.txt 2>/dev/null | head -1)"
if [ -z "$newest" ]; then echo "WARNING 一份快照都没有"; exit 1; fi
age=$(( $(date +%s) - $(stat -c %Y "$newest") ))
echo "最新快照 $(basename "$newest")（${age}s 前）"
if [ "$age" -gt "$STALE_SECONDS" ]; then
  echo "WARNING 快照链路可能已坏：最新快照 ${age}s 前（> ${STALE_SECONDS}s）"
  exit 1
fi
exit 0
