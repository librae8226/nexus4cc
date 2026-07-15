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

# ── Phase 1: Python 模糊匹配 pane 标题 → conversation session ID ──
# 输出格式（每行）: session:window.pane|resume_arg
#   resume_arg = <session-uuid>  → 精确匹配，用 --resume <id>
#   resume_arg = CONTINUE        → 无匹配，回退 --continue
MATCHES=$(python3 -c "
import json, os, glob, re, sys

SNAP = '$SNAP'

# collect panes from snapshot
panes = []
with open(SNAP) as f:
    for line in f:
        if not line.startswith('pane\t'): continue
        p = line.strip().split('\t')
        sess, win, pidx, title = p[1], p[2], p[5], p[6]
        cwd = p[7][1:] if p[7].startswith(':') else p[7]
        pfull = p[10][1:] if p[10].startswith(':') else p[10]
        if 'nexus-run-claude.sh' not in pfull: continue
        title = re.sub(r'^[✳⠐⏵⚡✅❌⚠️🔍📝🔄 ]+', '', title).strip()
        panes.append((f'{sess}:{win}.{pidx}', title, cwd.rstrip('/')))

def unigram_jaccard(a, b):
    sa, sb = set(a.lower()), set(b.lower())
    for noise in ' ,.。，、：:（）()@/#!！?？\n\r\t':
        sa.discard(noise); sb.discard(noise)
    if not sa or not sb: return 0
    return len(sa & sb) / len(sa | sb)

def contains_score(short, long):
    ss = set(short) - set(' ,.。，、：:（）()@/#!！?？\n\r\t')
    if not ss: return 0
    return len(ss & set(long)) / len(ss)

for target, title, cwd in panes:
    pd = os.path.expanduser(f'~/.claude/projects/{cwd.replace(\"/\", \"-\")}')
    best_score, best_sid = 0, ''
    for f in sorted(glob.glob(f'{pd}/*.jsonl'), key=os.path.getmtime, reverse=True):
        sid = os.path.basename(f)[:-6]
        all_texts = []
        try:
            with open(f) as fh:
                for line in fh:
                    d = json.loads(line)
                    if d.get('type') == 'user' and d.get('message',{}).get('role') == 'user':
                        content = d['message'].get('content','')
                        if isinstance(content, list):
                            text = ' '.join(p.get('text','') for p in content if p.get('type')=='text')
                        else: text = str(content)
                        if text.startswith('<') or text.startswith('Base directory'): continue
                        all_texts.append(text)
        except: pass
        for text in all_texts:
            score = 0.5 * unigram_jaccard(title, text[:300]) + 0.5 * contains_score(title, text[:300])
            if score > best_score:
                best_score, best_sid = score, sid

    if best_score > 0.15:
        print(f'{target}|{best_sid}|{best_score:.2f}|{title[:60]}')
    else:
        print(f'{target}|CONTINUE|{best_score:.2f}|{title[:60]}')
" 2>&1)

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

  # 安全校验：对比快照中的 window name 与当前 window name。
  # 若不同（例如用户在该 index 新建了窗口），跳过——避免把对话注入到错误的窗口。
  snap_win_name="$(grep -P "^window\t$sess\t$win\t" "$SNAP" | head -1 | awk -F'\t' '{print $4}' | sed 's/^://;s/^-//')"
  cur_win_name="$(tmux display-message -p -t "$sess:$win" '#{window_name}' 2>/dev/null)"
  if [ -n "$snap_win_name" ] && [ -n "$cur_win_name" ] && [ "$snap_win_name" != "$cur_win_name" ]; then
    echo "[nexus-resume] $target window 名不匹配（快照='$snap_win_name' 当前='$cur_win_name'），跳过"
    continue
  fi

  # 从快照提取该 pane 的完整启动命令
  pfull="$(grep -P "^pane\t$sess\t$win\t" "$SNAP" | head -1 | awk -F'\t' '{print $11}' | sed 's/^://')"
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
