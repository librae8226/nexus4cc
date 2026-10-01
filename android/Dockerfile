# nexus-android-build —— Nexus 的 Android 构建环境
#
# 为什么用容器（按 ~/.claude/CLAUDE.md「能 Docker 不破坏原生环境」）：
# Android SDK 是几 GB 的东西，且版本换代频繁。装进镜像后主机保持干净，换
# JDK/SDK 版本只要重建镜像，不会有"机器上残留哪个版本"的问题。
# adb 刻意**不**放进来 —— USB 设备直通到容器里很别扭，设备侧操作留在主机。
#
# 构建上下文是 android/ 而非仓库根：镜像里只需要工具链，源码在运行时
# 用 -v 挂进来（见 build-apk.sh），这样改代码不用重建镜像。
FROM eclipse-temurin:21-jdk-jammy

ARG CMDLINE_TOOLS_BUILD=16111833
ARG ANDROID_PLATFORM=android-36
# 36.0.0 是 compileSdk=36 配套的；35.0.0 不是我们选的，是 AGP 8.13.0 自带的
# 默认 buildToolsVersion —— 它对每个 subproject 生效，与 compileSdk 无关。
# 不预装的话 Gradle 会试图在运行期自己下载，而那时容器是以宿主 uid 跑的，
# 对 /opt/android-sdk 没有写权限，构建直接失败。
ARG BUILD_TOOLS_VERSION=36.0.0
ARG BUILD_TOOLS_EXTRA=35.0.0

ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# cmdline-tools 的下载文件名带构建号（没有稳定的 latest.zip），所以这里钉死。
# 找不到时去 https://dl.google.com/android/repository/repository2-3.xml 查
# cmdline-tools;latest 的 complete/url。构建失败会明确报 404，不会静默降级。
RUN mkdir -p "${ANDROID_HOME}/cmdline-tools" \
    && curl -fsSL -o /tmp/cmdline-tools.zip \
       "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_BUILD}_latest.zip" \
    && unzip -q /tmp/cmdline-tools.zip -d "${ANDROID_HOME}/cmdline-tools" \
    && mv "${ANDROID_HOME}/cmdline-tools/cmdline-tools" "${ANDROID_HOME}/cmdline-tools/latest" \
    && rm /tmp/cmdline-tools.zip

# 许可证必须在这里接受：运行期容器是 -u <宿主 uid>，没有写 SKD 目录的权限。
RUN yes | sdkmanager --licenses > /dev/null \
    && sdkmanager --install \
         "platform-tools" \
         "platforms;${ANDROID_PLATFORM}" \
         "build-tools;${BUILD_TOOLS_VERSION}" \
         "build-tools;${BUILD_TOOLS_EXTRA}" > /dev/null \
    && sdkmanager --list_installed

WORKDIR /app
