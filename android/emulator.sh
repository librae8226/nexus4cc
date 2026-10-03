#!/usr/bin/env bash
# emulator.sh —— 无头 Android 模拟器，用来在交出去之前自己先把 APK 跑一遍。
#
# 为什么需要：改 Android 相关的东西以前只能"改完丢给真机看"，结果按住说话没录音
# 这种事要等用户装完才知道。有了它，改完 → 装上 → 点 → 截图，全在本机闭环。
#
# 容器形态（沿用 `能 Docker 不破坏原生环境`）：emulator + system image 有 9GB，
# 放镜像里；AVD 放具名卷，重建容器不丢。KVM 直通给宿主 librae 有 ACL 的 /dev/kvm。
#
# 用法：
#   android/emulator.sh start          起模拟器（后台常驻，约 30–60 秒开机）
#   android/emulator.sh stop           停掉并删容器（AVD 保留）
#   android/emulator.sh status         看容器与开机状态
#   android/emulator.sh adb <args...>  在容器里跑 adb
#   android/emulator.sh install <apk>  装 APK
#   android/emulator.sh shot <out.png> 截屏到宿主文件
#   android/emulator.sh tap <x> <y>    点一下
#   android/emulator.sh swipe <x1> <y1> <x2> <y2> [ms]
#   android/emulator.sh logcat [grep]  看日志
#
# 网络：容器用 --network host，所以模拟器里的 10.0.2.2 就是这台宿主机，
#       直接指向本机 Nexus（:59000）。
set -euo pipefail

IMAGE="${EMU_IMAGE:-nexus-android-emulator}"
NAME="${EMU_NAME:-nexus-emulator}"
VOLUME="${EMU_VOLUME:-nexus-avd}"
AVD="${EMU_AVD:-nexus}"
API="${EMU_API:-34}"
# 自定义 rom 用 googlex86 系；这里用带 google_apis 的，WebView 版本够新
SYSIMG="${EMU_SYSTEM_IMAGE:-system-images;android-${API};google_apis;x86_64}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERIAL="emulator-5554"

in_container() { docker exec "$NAME" "$@"; }

ensure_avd() {
  in_container bash -lc "
    set -e
    export ANDROID_HOME=/opt/android-sdk
    if [ ! -d \"\$HOME/.android/avd/${AVD}.avd\" ]; then
      echo 'no' | avdmanager create avd -n ${AVD} -k '${SYSIMG}' --device pixel_6 --force
      # 麦克风要显式打开：默认的 AVD 模板不一定带 audioInput
      printf 'hw.audioInput=yes\nhw.audioOutput=no\nhw.keyboard=yes\n' >> \"\$HOME/.android/avd/${AVD}.avd/config.ini\"
      echo '[emulator] AVD ${AVD} 已创建'
    else
      echo '[emulator] AVD ${AVD} 已存在'
    fi
  "
}

case "${1:-}" in
  start)
    if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
      echo "[emulator] 容器已在跑"
    else
      docker rm -f "$NAME" >/dev/null 2>&1 || true
      echo "[emulator] 启动容器（headless，KVM 直通）"
      docker run -d --name "$NAME" \
        --device /dev/kvm \
        --network host \
        --shm-size 2g \
        -v "${VOLUME}:/root/.android" \
        -v "${HERE}/..:/work" \
        -w /work \
        "$IMAGE" sleep infinity >/dev/null
    fi
    ensure_avd
    # 注意：不能用 `pgrep -f qemu-system` —— 跑 pgrep 的 sh 自己的命令行里就含这个词，
    # 会匹配到自己，于是永远"已在运行"，模拟器根本不启动（踩过）。
    if in_container pgrep -x qemu-system-x86_64 >/dev/null 2>&1; then
      echo "[emulator] 模拟器已在运行"
    else
      echo "[emulator] 启动 emulator（首帧较慢）"
      # 用 docker exec -d 真正脱离：在 exec 里 nohup & 会随 exec 会话一起被收掉
      docker exec -d "$NAME" bash -lc "
        export ANDROID_HOME=/opt/android-sdk
        exec emulator -avd ${AVD} \
          -no-window -no-boot-anim -no-snapshot \
          -gpu swiftshader_indirect \
          -netdelay none -netspeed full
      "
    fi
    echo "[emulator] 等开机（最多 4 分钟）…"
    in_container bash -lc "export ANDROID_HOME=/opt/android-sdk; adb start-server >/dev/null 2>&1; \
      adb wait-for-device; \
      for i in \$(seq 1 120); do \
        [ \"\$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')\" = 1 ] && break; sleep 2; done; \
      echo -n 'boot_completed='; adb shell getprop sys.boot_completed | tr -d '\r'; \
      adb shell getprop ro.build.version.release | tr -d '\r'"
    ;;

  stop)
    docker rm -f "$NAME" >/dev/null 2>&1 && echo "[emulator] 已停" || echo "[emulator] 本来就没跑"
    ;;

  status)
    docker ps --filter "name=$NAME" --format '容器：{{.Status}}' || true
    in_container bash -lc "export ANDROID_HOME=/opt/android-sdk; adb devices; \
      echo -n 'boot_completed='; adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r'" 2>/dev/null || true
    ;;

  adb)   shift; in_container bash -lc "export ANDROID_HOME=/opt/android-sdk; adb $*" ;;
  install)
    [ -n "${2:-}" ] || { echo "用法：emulator.sh install <apk>"; exit 2; }
    in_container bash -lc "export ANDROID_HOME=/opt/android-sdk; adb install -r '$2'"
    ;;
  shot)
    out="${2:-/tmp/emu.png}"
    in_container bash -lc "export ANDROID_HOME=/opt/android-sdk; adb exec-out screencap -p" > "$out"
    echo "截图 → $out"
    ;;
  tap)   shift; in_container bash -lc "export ANDROID_HOME=/opt/android-sdk; adb shell input tap $*" ;;
  swipe) shift; in_container bash -lc "export ANDROID_HOME=/opt/android-sdk; adb shell input swipe $*" ;;
  text)  shift; in_container bash -lc "export ANDROID_HOME=/opt/android-sdk; adb shell input text '$*'" ;;
  logcat)
    if [ -n "${2:-}" ]; then
      in_container bash -lc "export ANDROID_HOME=/opt/android-sdk; adb logcat -d -v brief | grep -i -- '$2' | tail -60"
    else
      in_container bash -lc "export ANDROID_HOME=/opt/android-sdk; adb logcat -d -v brief | tail -80"
    fi
    ;;

  *)
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
