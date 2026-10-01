#!/usr/bin/env bash
# 在容器里跑 Gradle。用法：
#   android/build-apk.sh assembleDebug        # 产出 android/app/build/outputs/apk/debug/
#   android/build-apk.sh assembleRelease
#   android/build-apk.sh clean
#
# 不传参数则默认 assembleDebug。
#
# 前置：前端产物必须先构建好 ——  cd frontend && npm run build
#       （本脚本不代为构建：那会改动线上正在伺服的 frontend/dist，
#         发布是发布、构建是构建，不该由一个 Gradle 包装脚本顺手触发。）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE=nexus-android-build
# Gradle 用户目录（Gradle 发行版 + 依赖缓存，约 1-2GB）落在仓库内且已 gitignore。
# 用宿主目录而不是 docker 命名卷：容器以宿主 uid 运行，命名卷是 root 所有，
# 写不进去。放这里还能顺手用普通文件工具查看/清理。
GRADLE_HOME_DIR="${REPO_ROOT}/android/.gradle-home"

mkdir -p "${GRADLE_HOME_DIR}"

# 把 frontend/dist 同步进 android/app/src/main/assets/。
# 漏了这步的后果是"改了前端但 APK 里还是旧界面"，而且没有任何报错 —— 静默失败
# 最难查，所以放在这里强制走一遍（那两者都已 gitignore，不会污染工作区）。
if [[ ! -f "${REPO_ROOT}/frontend/dist/index.html" ]]; then
  echo "[build-apk] 找不到 frontend/dist/index.html，请先：cd frontend && npm run build" >&2
  exit 1
fi
echo "[build-apk] 同步 web 资源（frontend/dist 时间戳：$(date -r "${REPO_ROOT}/frontend/dist/index.html" '+%F %T'))"
(cd "${REPO_ROOT}" && npx --no-install cap sync android)

if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "[build-apk] 镜像 ${IMAGE} 不存在，先构建（首次约 3-5 分钟）..." >&2
  docker build -f "${REPO_ROOT}/android/Dockerfile" -t "${IMAGE}" "${REPO_ROOT}/android"
fi

# -u 宿主 uid：否则构建产物（android/app/build/ 等）会变成 root 所有，
#              之后 git status / 清理都得 sudo。
# 首次运行会下载 Gradle 8.14.3 发行版（约 130MB），之后走缓存。
exec docker run --rm \
  -u "$(id -u):$(id -g)" \
  -v "${REPO_ROOT}:/app" \
  -v "${GRADLE_HOME_DIR}:/gradle-home" \
  -e GRADLE_USER_HOME=/gradle-home \
  -e HOME=/tmp \
  -w /app/android \
  "${IMAGE}" \
  ./gradlew "${@:-assembleDebug}"
