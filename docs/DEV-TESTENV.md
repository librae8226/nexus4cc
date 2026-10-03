# 本机开发测试环境（Android + 前端）

> 目的：**改完能自己验，再交出去。** 以前改 Android 相关的东西只能"盲改完丢给真机碰运气"，
> 结果按住说话没录音这种事，要等用户把 APK 装到手机上才发现。

两套，各管一段：

| 要验什么 | 用什么 | 代价 |
|---|---|---|
| 前端 UI / 交互 / 布局 | 本机 Chrome（9222）+ `scripts/dev-cdp.mjs` | 秒级 |
| Android 真行为（权限、WebView、录音、触摸、APK 安装） | 无头模拟器 `android/emulator.sh` | 秒级（首次开机约 1 分钟） |

---

## 1. Android 模拟器

```bash
android/emulator.sh start      # 起容器 + 开机（首次约 1 分钟），幂等
android/emulator.sh status
android/emulator.sh install android/app/build/outputs/apk/walkie/debug/app-walkie-debug.apk
android/emulator.sh shot /tmp/emu.png
android/emulator.sh tap 540 2160
android/emulator.sh hold 540 2160 2000     # 长按 2 秒（按住说话要这个）
android/emulator.sh swipe x1 y1 x2 y2 400
android/emulator.sh text "hello"
android/emulator.sh logcat WebView          # 看日志
android/emulator.sh stop                    # 停掉（AVD 保留，下次开机快）
```

**配置**（都可环境变量覆盖）：镜像 `nexus-android-emulator`、容器 `nexus-emulator`、
AVD 具名卷 `nexus-avd`、API 34 / `google_apis` / x86_64。

**为什么是容器**：emulator + system image 有 9GB，装进镜像里宿主保持干净（同 `android/Dockerfile`）。
KVM 用 `--device /dev/kvm` 直通 —— 宿主 `librae` 对 `/dev/kvm` 有 ACL 写权限（无需加 kvm 组）。
容器 `--network host`，所以模拟器里的 **`10.0.2.2` 就是这台宿主机**，直连本机 Nexus `:59000`。

**两个坑**（都踩过）：
- 判断"模拟器是否在跑"有两个坑，**两个都踩过**：
  1. `pgrep -f qemu-system` —— 跑 pgrep 的 sh 自己命令行里就含这个词，会匹配到自己，
     于是永远"已在运行"，emulator 根本不启动；
  2. `pgrep -x qemu-system-x86_64` —— 同样匹配不上：内核的 `comm` 只保留 15 个字符，
     真实进程名 `qemu-system-x86_64-headless` 被截成 `qemu-system-x86`。
  **用 `pgrep -f '[q]emu-system-x86'`**（`[q]` 是为了让它别匹配到自己）。
  症状是"模拟器其实起来了，脚本却说没起"，或者反过来卡在"已在运行"—— 两种都见过。
- 万一判断失误、容器在跑但模拟器没起来，手工补一刀：
  `docker exec -d nexus-emulator bash -lc 'export ANDROID_HOME=/opt/android-sdk; exec emulator -avd nexus -no-window -no-boot-anim -no-snapshot -gpu swiftshader_indirect'`
- 启动要 `docker exec -d`；在 `docker exec` 里 `nohup … &` 会随 exec 会话一起被收掉。

---

## 2. App 的 WebView 调试（看真机行为的关键）

Capacitor 的 debug 包里 WebView 调试是开的，可以把它接到宿主机上像普通 Chrome 一样操作：

```bash
PID=$(android/emulator.sh adb "shell pidof com.librae.nexus.walkie" | tr -d '\r')
android/emulator.sh adb "forward tcp:9333 localabstract:webview_devtools_remote_$PID"
curl -s http://127.0.0.1:9333/json/list     # 应看到一个 page
```

然后：

```bash
node scripts/dev-cdp.mjs shot x /tmp/a.png --attach http://127.0.0.1:9333 \
  --eval "JSON.stringify(Object.keys(localStorage))" \
  --hold ".walkie-ptt" 2500
```

`--hold` / `--tap` 走 CDP 的 `Input.dispatchTouchEvent`，是**可信**输入。
用 JS `dispatchEvent` 造的合成事件不算用户手势，`getUserMedia` 会直接拒绝 —— 测不了录音。

### 让 App 指到本机 Nexus 并免登录

`baseUrl.ts` 从 localStorage 读服务器配置，所以可以一次性写进去：

```bash
TOKEN=$(node -e "const fs=require('fs');const m=fs.readFileSync('.env','utf8').match(/^JWT_SECRET=(.*)$/m);console.log(require('jsonwebtoken').sign({},m[1].trim(),{expiresIn:'12h'}))")

node scripts/dev-cdp.mjs shot x /tmp/a.png --attach http://127.0.0.1:9333 \
  --eval "localStorage.setItem('nexus_profiles',JSON.stringify([{id:'emu',url:'http://10.0.2.2:59000',name:'emulator'}]))" \
  --eval "localStorage.setItem('nexus_active_profile','emu')" \
  --eval "localStorage.setItem('nexus_token','$TOKEN')" \
  --eval "localStorage.setItem('nexus_ui_mode','walkie')" \
  --eval "localStorage.setItem('nexus_theme','dark')" \
  --eval "location.reload();'ok'"
```

（token 是本地签的，`JWT_SECRET` 在 `.env`，过期时间自定。）

### 麦克风

模拟器的麦克风默认是**静音**，所以转写结果会是空 —— 这足以验证"录音通路是否打通"
（看 `data/audit.log` 里有没有 `walkie-transcribe` 条目、字节数是否非零），
但**验不了识别准确率**。要验准确率得用真机录音，或直接拿音频文件打
`intake` 的 `/transcribe`（见下）。

```bash
# 直接验 ASR（绕过手机）
curl -sS -X POST -H 'Content-Type: audio/webm' --data-binary @clip.webm \
  http://127.0.0.1:59011/transcribe
```

---

## 3. 前端 UI（桌面 Chrome）

```bash
node scripts/dev-cdp.mjs shot "http://127.0.0.1:59000/?ui=walkie" /tmp/w.png \
  --mobile --set nexus_token=$TOKEN --set nexus_theme=dark --wait 2500
```

`?ui=walkie` 直接进对讲机界面；`--mobile` 按 390×844 渲染并开触摸模拟。
它**只操作自己新建的 tab**，用完就关，不碰你正在用的页面。
