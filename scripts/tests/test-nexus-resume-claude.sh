#!/usr/bin/env bash
# Regression tests for the tmux session-restore scripts.
#
# Background: nexus-resume-claude.sh used GNU-only utilities that BSD userland does
# not provide (`grep -P`, `ps --ppid`). On macOS those calls fail, so snapshot parsing
# silently returned empty values and one-click session restore became a no-op; the
# window-name safety check was bypassed at the same time. These tests pin that down:
# they fail if the GNU-only calls come back, and they exercise the three code paths
# that used them.
#
# Usage: bash scripts/tests/test-nexus-resume-claude.sh
# Exits 0 on success, 1 on failure. Skips (exit 0) when a prerequisite is missing.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
RESUME="$ROOT/scripts/nexus-resume-claude.sh"   # script under test
RESTORE="$ROOT/scripts/nexus-restore-tmux.sh"   # second script touched by the portability fix
LAUNCHER="$ROOT/nexus-run-claude.sh"            # what actually runs inside a claude pane

for tool in tmux python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "SKIP: $tool is not installed"
    exit 0
  fi
done

WORK="$(mktemp -d)"
# Isolate the tmux server so the test never touches the developer's own sessions.
export TMUX_TMPDIR="$WORK/socket"
mkdir -p "$TMUX_TMPDIR"
SESS="nexustest-$$"

cleanup() {
  tmux kill-server >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass=0
fail=0

ok()  { echo "  PASS  $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $1"; echo "        $2"; fail=$((fail + 1)); }

# assert that $2 (command output) matches extended regex $3
assert_match() {
  if printf '%s' "$2" | grep -qE "$3"; then ok "$1"; else bad "$1" "expected /$3/, got: $(printf '%s' "$2" | tr '\n' '|')"; fi
}
# assert that $2 does NOT match extended regex $3
assert_no_match() {
  if printf '%s' "$2" | grep -qE "$3"; then bad "$1" "unexpected /$3/ in: $(printf '%s' "$2" | tr '\n' '|')"; else ok "$1"; fi
}

setup_session() {
  tmux kill-server >/dev/null 2>&1 || true
  tmux new-session -d -s "$SESS" -n shell 'exec bash'
  tmux new-window -t "$SESS" -n proj -c /tmp 'exec bash'
  tmux set-option -w -t "$SESS:1" automatic-rename off 2>/dev/null || true
  sleep 1
}

# Write a snapshot in the layout tmux-resurrect produces: a window line, a pane line
# whose last field is the pane's recorded start command, and a state line.
# $1 = window name to record in the snapshot (may intentionally differ from the live one)
write_snapshot() {
  local name="$1"
  {
    printf 'window\t%s\t1\t:%s\t1\t:*\tlayout\toff\n' "$SESS" "$name"
    printf 'pane\t%s\t1\t1\t:*\t0\tproj\t:/tmp\t1\tbash\t:NEXUS_PROXY= bash "%s" default /tmp\n' \
      "$SESS" "$LAUNCHER"
    printf 'state\t \t \n'
  } > "$WORK/snapshot.txt"
}

run_resume() { bash "$RESUME" --dry-run "$WORK/snapshot.txt" 2>&1; }

echo "== 1. static guard: no GNU-only utilities (BSD/macOS incompatible) =="
# Look at executable lines only (strip comments, which may legitimately name these
# constructs). grep -P and ps --ppid do not exist in BSD userland.
gnu_hits="$(sed 's/#.*//' "$RESUME" "$RESTORE" \
  | grep -nE 'grep[[:space:]]+-[A-Za-z]*P|--perl-regexp|--ppid|date[[:space:]]+-I' || true)"
assert_no_match "restore scripts contain no GNU-only grep -P / ps --ppid / date -I" "$gnu_hits" '.+'

echo "== 2. window-name safety check (guards snapshot field extraction) =="
setup_session
write_snapshot WRONGNAME          # snapshot disagrees with the live window name
out="$(run_resume)"
assert_no_match "no GNU utility errors" "$out" 'invalid option|illegal option'
assert_match    "mismatched snapshot window name is detected and skipped" "$out" 'window 名不匹配'

echo "== 3. 'launcher already running in the pane' guard =="
setup_session
write_snapshot proj
printf '#!/bin/bash\nsleep 30\n' > "$WORK/nexus-run-claude.sh"
chmod +x "$WORK/nexus-run-claude.sh"
tmux send-keys -t "$SESS:1" "bash \"$WORK/nexus-run-claude.sh\" &" C-m
sleep 1
out="$(run_resume)"
assert_no_match "no GNU utility errors" "$out" 'invalid option|illegal option'
assert_match    "pane already running the launcher is skipped" "$out" '已在跑 claude'

echo "== 4. clean pane receives a resume command =="
setup_session
write_snapshot proj
out="$(run_resume)"
assert_no_match "no GNU utility errors" "$out" 'invalid option|illegal option'
assert_match    "clean pane is resumed (--resume or --continue)" "$out" '\[DRY-RUN\].*(--resume|--continue)'

echo
echo "== summary: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
