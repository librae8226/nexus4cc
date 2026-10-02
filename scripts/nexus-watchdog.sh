#!/usr/bin/env bash
# nexus-watchdog.sh — 「页面必须活着」的看门狗（nexus-watchdog.timer 每分钟调一次）。
#
# 用户对健壮性的底线定义（2026-10-02）：**无论怎么宕机，都要能通过 tailscale 打开 Nexus
# 页面，并在页面里起一个 recovery 用途的 agent。** 所以本脚本只关心一件事：59000 上的
# 页面在不在，以及 nexus 这个 PM2 app 是否还在列表里（dump.pm2 被断电写坏时 resurrect
# 会一个都拉不起来）。
#   · nexus 不在 PM2 列表 → 从仓库里的 ecosystem.config.cjs 重新拉起
#   · 连续 3 次探活失败 → pm2 restart nexus
# 只做这两件事（不碰 tmux、不碰别的服务），动作写 audit + 微信，便于事后追溯。
set -u

# 可用环境变量覆盖，便于演练：NEXUS_WATCHDOG_URL=... NEXUS_WATCHDOG_DRY_RUN=1
URL="${NEXUS_WATCHDOG_URL:-http://127.0.0.1:59000/}"
STRIKES="${NEXUS_WATCHDOG_STRIKES:-/tmp/nexus-watchdog.strikes}"
FNMBIN=/home/librae/.local/share/fnm/node-versions/v24.21.0/installation/bin
PM2=/home/librae/.local/share/fnm/node-versions/v24.21.0/installation/lib/node_modules/pm2/bin/pm2
REPO=/home/librae/work/nexus
export PM2_HOME=/home/librae/.pm2
export PATH="$FNMBIN:/usr/local/bin:/usr/bin:/bin"

# 刚开机的 3 分钟内不动手：pm2 resurrect / tmux unit / nexus 自己都还在起
up="$(awk '{print int($1)}' /proc/uptime 2>/dev/null || echo 0)"
if [ "$up" -lt 180 ]; then echo "刚开机 ${up}s，跳过"; exit 0; fi

if curl -sf -m 5 -o /dev/null "$URL"; then rm -f "$STRIKES"; exit 0; fi

strikes="$(cat "$STRIKES" 2>/dev/null || echo 0)"; strikes=$((strikes + 1)); echo "$strikes" > "$STRIKES"
echo "探活失败第 $strikes 次（$(date -Is)）"
[ "$strikes" -lt 3 ] && exit 0
rm -f "$STRIKES"

if "$PM2" describe nexus >/dev/null 2>&1; then
  action="nexus 探活失败 3 次 → pm2 restart nexus"
  "$PM2" restart nexus >/dev/null 2>&1 || true
else
  action="nexus 不在 PM2 列表（dump.pm2 可能坏了）→ 从 ecosystem.config.cjs 拉起"
  "$PM2" start "$REPO/ecosystem.config.cjs" >/dev/null 2>&1 || true
fi

echo "$action"
if [ "${NEXUS_WATCHDOG_DRY_RUN:-0}" = "1" ]; then
  echo "（dry-run：只报决策，不动 pm2）"
  printf '{"ts":"%s","action":"watchdog-dry-run","source":"watchdog","detail":"%s"}\n' "$(date -Is)" "$action" \
    >> "$REPO/data/audit.log" 2>/dev/null || true
  exit 0
fi
printf '{"ts":"%s","action":"watchdog","source":"watchdog","detail":"%s"}\n' "$(date -Is)" "$action" \
  >> "$REPO/data/audit.log" 2>/dev/null || true
if [ -f /home/librae/work/wechat-agent/push.mjs ]; then
  node /home/librae/work/wechat-agent/push.mjs "【nexus】看门狗动手了：${action}。打开 https://<tailnet>/:59000 看页面。" >/dev/null 2>&1 || true
fi
exit 0
