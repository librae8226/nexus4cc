# ANDROID-APP.md — Nexus Android 客户端（需求 + 技术方案）

**锚点**: `docs/NORTH-STAR.md` | **状态**: 需求待评审 | **更新**: 2026-10-02

---

## 0. 一句话

把 Nexus 从「浏览器里能用的 PWA」升级成「装在手机上的原生外壳 App」——
**终端体验不变，但获得 PWA 永远拿不到的四件事：后台常驻、任务完成通知、系统级输入（语音/相机/分享）、生物识别锁定。**

---

## 1. 背景与动机

### 1.1 现状

Nexus 的移动端今天是 **PWA**：`public/manifest.json` + `public/sw.js`，iOS/Android 加主屏可安装。前端是 React 18 + xterm.js 5.5，由 `server.js` 同源伺服 `frontend/dist`。

### 1.2 PWA 的能力天花板

| 想要的能力 | PWA 现状 | 原因 |
|---|---|---|
| 后台常驻 | ❌ | 浏览器/WebView 切后台即挂起 JS，WebSocket 必断 |
| 任务完成通知 | ⚠️ 仅在页面存活时 | `Notification` 需要页面活着；锁屏后不可靠 |
| 语音输入 | ⚠️ 靠 IME 转写 | 走 `textarea` composition，正好命中已知的 xterm 双提交缺陷 |
| 拍照/相册发给 AI | ⚠️ 只能手动选文件 | 无系统相机入口，`<input type=file>` 体验差 |
| 从其他 App 分享进来 | ❌ | 无 `ACTION_SEND` 注册能力 |
| 指纹/人脸解锁 | ❌ | JWT 明文躺在 `localStorage`，30 天有效 |
| 长按图标直达项目 | ⚠️ | PWA shortcuts 支持零散，国产 ROM 上不可靠 |

### 1.3 为什么是现在

1. **北极星轴二已明确写下「移动端 App」** 作为交付渠道（`docs/NORTH-STAR.md:15`），当前只有 PWA 一条腿。
2. **竞品已经是原生 App**：README 对比表里的 Happy Coder / Omnara 都是原生客户端，"PWA / 可安装" 这一行是 Nexus 少有的劣势项（`README_CN.md:56`）。
3. **用户日常已经这么用**：地铁上给 AI 下任务、用语音输入、需要知道 Agent 什么时候跑完——这三个场景全是 PWA 的天花板。

### 1.4 锚点合规检查

| 规则 | 结论 |
|---|---|
| 增强三轴之一？ | ✅ 轴二（零摩擦上下文同步）+ 轴三（极致 Agent 管理） |
| 仍是单用户？ | ✅ 单密码 JWT，不引入账号体系 |
| 不替换 tmux？ | ✅ tmux 仍是唯一事实源，App 只是客户端 |
| 不做通用 Web SSH？ | ✅ 边界仍是 claude 工作流，不新增通用终端能力 |

---

## 2. 目标与非目标

### 2.1 v1 目标（可验证）

| # | 目标 | 验收方式 |
|---|---|---|
| G1 | 两台目标机型装上 APK，能登录、连上、终端可交互 | 真机走通完整流程 |
| G2 | 服务器地址可配置且可多套切换（局域网 / Tailscale / 隧道） | 三套 profile 各连一次 |
| G3 | App 切后台后，Agent 跑完能收到通知 | 锁屏 5 分钟后收到通知，点击回到对应窗口 |
| G4 | 能拍照/选图/分享文件给 AI，能在终端里说人话 | 各能力真机验证 |
| G5 | 启动需指纹解锁；JWT 不再明文落盘 | 见 §8 |
| G6 | 折叠屏展开/合上不丢连接、不重排错乱 | vivo X Fold6 反复开合 |

### 2.2 非目标（明确不做）

- **不做手机本机服务端**。不在 Android 上跑 Node/tmux/claude。
  理由：`targetSdk ≥ 29` 后 SELinux W^X 禁止对 app 私有目录 `exec()`，需要 `targetSdk = 28` 或 system-linker-exec 绕过——后者与 Android 14+ 的前台服务类型要求直接冲突。这是另一个产品，不是本需求。
- 不做 iOS。
- 不做多用户 / 团队 / 注册体系（违反 NS Out-of-Scope）。
- 不做离线模式。App 的价值就是连远端，无网即无意义。
- 不做 FCM 推送。纯本地通知。
- 不做自更新（OTA）。换版本 = 重新下载 APK。
- 不做传感器 / 定位 / NFC / 短信（无场景）。

---

## 3. 用户与场景

**用户 = 开发者本人**，一台 Debian 主机常驻跑多个 Claude Code Agent。

| 场景 | 现在（PWA） | 目标（APK） |
|---|---|---|
| **A. 地铁上收结果** | 必须保持页面在前台，否则断 | 锁屏也能收到「agent 跑完了」，点开直接跳到那个窗口 |
| **B. 拍白板给 AI** | 存图 → 切浏览器 → 选文件 | 相机 → 系统分享 → Nexus，路径自动进终端 |
| **C. 走路时口述需求** | IME 转写，偶发重复字 | 按麦克风按钮，原生语音识别，文字直送终端 |
| **D. 展开折叠屏继续干** | 展开后布局可能不跟随 | 无缝重排，终端尺寸自动 re-fit，连接不断 |
| **E. 手机丢了** | 30 天 JWT 明文可被提取 | 没有指纹打不开，token 在 Keystore 里 |

**场景 A 是最核心的**——它是"必须做 APK 而不是继续用 PWA"的唯一硬理由。

---

## 4. 功能需求

编号接 `docs/PRD.md` 的 F-22，本客户端为 **F-23**。

### 4.1 P0 — v1 必须

| ID | 功能 | 需求描述 | 验收标准 |
|---|---|---|---|
| **F-23.1** | 服务器地址多 Profile | App 内可增删改多套服务端地址，命名（如「家里局域网」「Tailscale」「Cloudflare」），一键切换；记住最后使用的一套；地址含 scheme + host + port。**地址必须先于登录存在**，因此存本地而非服务端 | 3 套 profile 各连一次成功；冷启动恢复上次 profile |
| **F-23.2** | 后台常驻 + 任务完成通知 | 前台服务常驻；Agent 由「有输出」转为「静默」时发通知；通知标题=项目/窗口名，正文=最后一行输出摘要；点击直达该窗口 | 锁屏 5 分钟后收到通知，<10s 内送达，点击落到正确窗口 |
| **F-23.3** | 语音输入 | 工具栏麦克风按钮 → 原生语音识别 → 文字注入终端；识别中显示状态 | 中文识别可用，文字不重复不丢字 |
| **F-23.4** | 相机 / 相册输入 | 拍照或选图 → 上传到服务端 → 终端自动填入路径 | 从拍照到路径出现在终端 ≤ 5s |
| **F-23.5** | 文件 SAF 与系统分享接入 | (a) 终端产物可保存到手机下载目录；(b) 注册 `ACTION_SEND`，其他 App 分享文本/图片进来可直接送给 AI | 从相册「分享到 Nexus」可用；终端文件能存到 Download |
| **F-23.6** | 生物识别 + 安全存储 | 冷启动/回前台需指纹或人脸解锁；JWT 存入 Keystore 加密存储，不再用 `localStorage` | 关闭指纹则无法进入；本地文件里搜不到明文 JWT |
| **F-23.7** | 桌面快捷方式 | 长按图标直达指定项目/频道 | 生成的快捷方式点击直达 |
| **F-23.8** | 安全区与折叠屏适配 | `viewport-fit=cover` + 安全区内边距；展开/合上不重建 Activity、不丢 WS | 刘海/挖孔不挡内容；Fold6 开合 10 次连接不断 |

### 4.2 P1 — 首版后尽快

| ID | 功能 | 说明 |
|---|---|---|
| F-23.9 | 桌面小组件 | 只读展示各 Agent 状态（运行中/等待/空闲） |
| F-23.10 | 通知快捷回复 | 通知栏直接回一句给 Agent，不用打开 App |
| F-23.11 | 下拉即刷新会话列表 | 替代当前 3s 轮询 |

### 4.3 P2 — backlog

- 通知分级 / 免打扰时段
- 多主机同时在线（现在一次连一台）
- 平板/横屏双栏布局
- App 内更新检查（复用 `/api/version/latest`）

---

## 5. 非功能需求

### 5.1 兼容性矩阵

| 设备 | 系统 | 基座 | 特殊关注 |
|---|---|---|---|
| vivo X Fold6 | OriginOS 6 Fold | Android 16 | 折叠屏开合、**智能后台冻结**（OriginOS 5 起新增，白名单外闲置约 3 分钟即休眠） |
| OnePlus Ace 5 Pro | ColorOS 16 | Android 16 | 自启动列表上限约 5 个；纯净后台 |

两台机器都是 **Android 16 / API 36**，因此 FGS 的 `dataSync` 6 小时/24 小时配额规则**必然生效**。

### 5.2 性能与功耗

| 指标 | 目标 |
|---|---|
| APK 体积 | ≤ 10 MB（arm64-v8a 单 ABI） |
| 冷启动到可登录 | ≤ 2s |
| 后台常驻功耗 | ≤ 2%/小时（前台服务 + 单条长连接） |
| 通知送达延迟 | ≤ 10s（静默判定窗口内） |

### 5.3 安全

- **CORS**：服务端当前**完全没有 CORS 配置**（`server.js` 无 `cors` 包、无 ACAO 头）。WebView 有独立 origin，跨源请求必须放行。按项目规范「生产必须列白名单，不许通配符」，用环境变量 `CORS_ORIGINS` 显式列举。
- **明文流量**：局域网/Tailscale profile 是 `http://`，需要 Android 网络安全配置放行明文。这是个人自托管 App 的已知取舍，**在设置界面显式提示**"该地址未加密"。
- **Token**：从 `localStorage` 迁到 Keystore 加密存储；`docs` 里已知的"JWT 走 query string 可能进代理日志"问题在 APK 场景不变，但可用生物识别降低设备侧风险。
- **网络暴露**：§5.1 的多 profile 设计**不改变**服务端暴露面。公网路径仍由现有 Cloudflare Tunnel / Tailscale 承担，Nexus 自身依旧不终止 TLS。

---

## 6. 技术方案

### 6.1 总体架构

```
┌─────────────────── Android 手机 ───────────────────┐
│  Capacitor WebView  (http://localhost)             │
│  ├─ 复用 frontend/dist 100%（React + xterm.js）     │
│  ├─ 新增：base-URL 抽象层、server profile 设置       │
│  └─ 新增：安全区 / 折叠屏 / 返回键 / 外链 / 剪贴板    │
│                        ▲                            │
│                  Capacitor 桥（JS ⇄ Kotlin）        │
│                        ▼                            │
│  自研 Nexus 原生层（Kotlin）                        │
│  ├─ ForegroundService ── 持有 monitor WS（后台也活着）│
│  ├─ 通知 / 语音识别 / 相机 / SAF / 分享接收           │
│  ├─ BiometricPrompt + Keystore 加密存储             │
│  └─ ShortcutManager                                 │
└──────────────────────┬─────────────────────────────┘
                       │  http(s)://<profile>
                       ▼
┌──────────────── Debian 主机 ────────────────────────┐
│  server.js（PM2）                                    │
│  ├─ 新增：CORS 白名单中间件（CORS_ORIGINS）           │
│  ├─ 新增：/ws/monitor 事件流（结构化活动/静默/退出）   │
│  └─ 其余不动：/ws 终端、/api/*、tmux 仍是唯一事实源    │
└─────────────────────────────────────────────────────┘
```

**核心设计原则**：WebView 只负责交互式终端；**常驻连接由原生层持有**。WebView 被系统挂起时交互 WS 断开是可接受的——tmux 保状态、重连即回放 2KB、前端已有指数退避重连（`Terminal.tsx:1495-1565`）和 `visibilitychange → sendResize`（`Terminal.tsx:1448-1452`）。真正不能被挂起的只有"通知"这一件事，它交给原生。

### 6.2 选型结论

**选定：Capacitor（仅 Android）。**

被否决的方案：

| 方案 | 否决理由 |
|---|---|
| Tauri v2 | APK 更小（4-6MB）且 Rust 侧持有后台 WS 很优雅，但官方插件无相机、无前台服务，通知以外几乎都要自己写 Kotlin；构建还要加 Rust + NDK。**生态不成熟，单人维护风险高。** |
| 裸 Kotlin + WebView | APK 最小（1-3MB），但文件选择器、权限、返回键、SAF、通知、FGS、生物识别全要自己写，没有社区沉淀。省下的 3-5MB 不值这些工时。 |
| Flutter / React Native | 要重写整套 xterm.js + React UI，直接抛弃现有前端资产。违背「能复用不新建」。 |
| TWA / Bubblewrap 包 PWA | 需要公网 HTTPS 源 + Digital Asset Links，且**零硬件访问能力**，等于没解决问题。 |
| Termux 生态拼装 | 不是可交付的产品形态，且把"手机当主机"的复杂度引了进来。 |

### 6.3 服务端改动（刻意最小）

**改动 1 — CORS 白名单中间件**

- 位置：`server.js` 静态伺服之前（当前 `server.js:186`）。
- 新增环境变量 `CORS_ORIGINS`，逗号分隔，例如 `http://localhost,https://localhost`。
- **默认空值 = 完全维持现状**（不发任何 ACAO 头），确保 PWA / 浏览器路径零影响。
- 必须处理 `OPTIONS` 预检：`Authorization` 头会触发预检，需要 `Access-Control-Allow-Headers: Authorization, Content-Type`、`Access-Control-Allow-Methods`，以及 `Access-Control-Max-Age` 减少预检次数。
- 注意 SPA 兜底 `app.get('*')`（`server.js:1551`）只吃 GET，不干扰 OPTIONS；但中间件仍要注册在静态资源之前。
- 同步更新 `.env.example`，并在 commit body 里说明新增变量（项目规范要求）。

**改动 2 — `/ws/monitor` 结构化事件流**

这是通知能力的**关键设计决策**，先说为什么不能走别的路：

| 备选 | 问题 |
|---|---|
| 原生侧轮询现有 `/api/sessions/:id/output` | 该接口返回 `idleMs = now - lastActivity`。**Agent 思考 3 分钟和干完 3 分钟在这个信号上完全一样**，必然误报。而且要先知道窗口列表，轮询成本高、延迟大。 |
| 原生侧在客户端解析终端字节流猜 | 脆、脏、无法区分「等待输入」和「正在输出」。 |
| **`/ws/monitor`（选定）** | 服务端本来就持有每个 PTY 的 `clients` 集合和 `lastActivity`（`server.js:1559-1629`）。把结构化事件推给 monitor 订阅者是**几十行**的事，且浏览器端也能受益（可替掉 `TabBar.tsx:52` / `Terminal.tsx:478` 的 3s 轮询）。 |

协议（服务端 → 客户端，JSON，只推事件不推内容）：

| 事件 | 载荷 | 触发点 |
|---|---|---|
| `activity` | `{session, window, ts}` | 该窗口有输出字节。按窗口节流（≤1 次 / 250ms） |
| `idle` | `{session, window, idleMs}` | 该窗口由活动转为静默超过阈值（默认 45s），**每段活动只发一次** |
| `exit` | `{session, window, reason}` | 窗口关闭 / PTY 退出 |

**必须同时解决的一个坑**：PTY 在最后一个客户端断开 5 分钟后会被回收（`server.js:1701-1725`）。如果手机是唯一客户端、进了后台，PTY 死掉就没有输出可观测，通知能力失效。
→ 解法：monitor 订阅计入一个**独立的 `monitors` 集合**，它 (a) 接收事件、(b) **阻止 PTY 回收**、(c) **不参与尺寸协商**（绝不发 resize，不影响 `clientSizes` 的 last-writer-wins 逻辑）。只监控用户订阅的窗口（默认 = 当前项目的频道），避免为几十个窗口白养 tmux 客户端。

**改动 3 — 无。** 终端 WS 协议、`/api/*` 全部不动。

### 6.4 前端改动

**改动 A — base-URL 抽象（最大的必改项）**

现状是**没有任何"服务器地址"概念**：约 30 处相对路径 `fetch('/api/...')`，WebSocket 由 `location.host` 拼出（`Terminal.tsx:1485-1507`）。WebView 有自己的 origin，一装上就连不上。

- 新增 `frontend/src/serverBase.ts`：导出 `apiUrl(path)` / `wsUrl(params)` / `getServerBase()` / `setServerBase()`，地址存 `localStorage`。
- **收敛点而不是逐个改 30 处**：优先在 `fetch` 的调用层做统一包装（新增一个 `apiFetch` 并替换调用点），WS 只改 `Terminal.tsx:1507` 一处构造 + `1485` 的 protocol 推导。
- **浏览器/PWA 路径零影响**：`getServerBase()` 在无配置时返回 `''`，相对路径行为与今天完全一致。
- 地址设置界面放在登录页之前（地址必须先于登录存在），复用 `GeneralSettings.tsx` 的样式。

**改动 B — Service Worker 在 APK 里必须停用**

WebView origin 是安全上下文，`sw.js` 会真的跑起来。它的 cache-first 策略会**跨版本供应旧的哈希 bundle**，造成升级后白屏/行为不一致。

- 用运行期判定而非双构建：`window.Capacitor?.isNativePlatform()` 为真时跳过 `main.tsx:7-11` 和 `App.tsx:16-18` 的注册。**一个 bundle 同时服务浏览器和 App**，符合「最小变更」。

**改动 C — 安全区与 viewport**

`frontend/index.html` 的 viewport 缺 `viewport-fit=cover`，全仓无 `env(safe-area-inset-*)`，`Terminal.tsx:1813-1820` 的 `position:fixed` 根容器会钻到刘海/导航栏下面。

**改动 D — 通知权限调用替换**

`Terminal.tsx:373-376` 的 `Notification.requestPermission()` 在 WebView 里不会走系统弹窗，需替换为原生权限请求（API 33+ 的 `POST_NOTIFICATIONS`）。

**改动 E — 顺带修两处折叠屏**

`Terminal.tsx` 自己已经用 `matchMedia` 规避了折叠屏 resize 不可靠的问题（`Terminal.tsx:354-366`），但 `SessionManager.tsx` 和 `WorkspaceSelector.tsx` 还在用 `window.resize`，展开时可能不重排。顺手改成 `matchMedia`。

### 6.5 Capacitor 壳配置要点

| 配置 | 取值 | 理由 |
|---|---|---|
| `server.androidScheme` | **`http`** | 默认是 `https`（→ origin `https://localhost`），而 `allowMixedContent` 默认 `false`。**https 页面无法请求 `http://192.168.x.x` / `http://100.x.x.x` 的 profile**——直接判死刑。改成 `http` 后壳 origin 是 `http://localhost`：与 http profile 同 scheme 无混内容问题，同时 `localhost` 仍是安全上下文（clipboard 等可用），且 http 页面请求 https 隧道地址也合法。**这一个配置同时满足三套 profile。** |
| `webContentsDebuggingEnabled` | debug 构建开，release 关 | `chrome://inspect` 调试 WebView 的唯一途径 |
| `configChanges` | 必须含 `orientation\|screenSize\|smallestScreenSize\|screenLayout\|density\|keyboardHidden\|uiMode` | **折叠屏开合 / 软键盘弹出 / 深浅色切换都不能重建 Activity**——重建就等于 WebSocket 断开、终端重排。这是 F-23.8 的技术根因。 |
| cleartext | 通过 `network_security_config.xml` 放行 | Capacitor 自带的 `cleartext` 选项文档明说"不用于生产"，因此不用它，改走标准网络安全配置 |
| `compileSdk` / `targetSdk` | 36 | Android 16 |
| `minSdk` | Capacitor 默认 | 两台测试机远超 |
| ABI | `arm64-v8a` 单 ABI（release） | 体积减半。debug 额外保留 `x86_64` 以便本机模拟器 |

### 6.6 原生能力 → 实现路径

| 能力 | 方案 | 说明 |
|---|---|---|
| 前台服务 | **自研 Kotlin** | 用 `specialUse` 类型（Android 16 上 `dataSync` 受 6h/24h 配额限制，`specialUse` **无时限**；App 侧载，不涉及 Play 审核）。持有 monitor WS，收到 `idle` 事件发通知 |
| 通知 | `@capacitor/local-notifications` + 自研通道 | 需要自建通知渠道、点击意图携带 `session/window` 以便跳转 |
| 语音识别 | `@capacitor-community/speech-recognition`（候选） | 走原生 `SpeechRecognizer`，**绕开 IME composition**，从根上避开已知的 xterm 双提交缺陷 |
| 相机 / 相册 | `@capacitor/camera` | 输出上传到现有 `POST /api/files/upload`（multipart → `data/uploads/日期/`），把返回路径注入终端。**复用现有接口，服务端零改动** |
| 文件保存到手机 | 自研 Kotlin（SAF）或 `@capacitor/filesystem` | Android 11+ 分存储作用域下，写公共下载目录需要 SAF 的 `ACTION_CREATE_DOCUMENT` |
| 接收系统分享 | 自研 Kotlin | 需在 manifest 注册 `ACTION_SEND`（`text/plain` + `image/*`）的 intent-filter，再桥接给 WebView |
| 生物识别 | 自研 Kotlin（`BiometricPrompt`） | 倾向自研而非社区插件，因为要和应用解锁状态、Keystore 存储联动 |
| 安全存储 | Keystore 加密存储 | 替换 `localStorage['nexus_token']` |
| 桌面快捷方式 | 自研 Kotlin（`ShortcutManagerCompat` + 静态 `shortcuts.xml`） | 无成熟 Capacitor 插件 |
| 返回键 / 外链 / 剪贴板 | `@capacitor/app` + 自研 | 外链必须出到系统浏览器（`WebLinksAddon` 现在强制 `window.open`，`Terminal.tsx:1012-1016`） |

> 插件包名为候选，实施时逐个核对与 Capacitor 8 / AGP 版本的兼容性；不兼容的直接降级为自研 Kotlin，路径已在表中给出。

### 6.7 通知判定与防打扰

静默判定必须能区分「思考中」和「干完了」。仅靠 `idleMs` 做不到，因此判据是**状态机**：

```
窗口有输出          → BUSY
BUSY 且静默 > 45s   → IDLE  → 发通知（每段活动只发一次）
IDLE 又有输出       → BUSY  （重新武装）
```

叠加的抑制规则（避免通知刷屏）：

1. 只对**用户订阅的窗口**发（默认当前项目的频道）。
2. App 正在前台且该窗口就是当前窗口 → 不发。
3. 同一窗口距上次通知 < 5 分钟 → 不发。
4. 阈值 45s 可在设置里调（30s / 45s / 2min）。

### 6.8 国产 ROM 保活

这是**通知可靠性的最大风险**，且代码能做的很有限。分两层：

**代码层**（能做的全做）
- 申请 `POST_NOTIFICATIONS`（API 33+）与前台服务权限。
- 引导 `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`。
- 首次启动跑一个**引导页**，逐条把用户送到厂商设置页（`try/catch` 兜底跳 `ACTION_APPLICATION_DETAILS_SETTINGS`）：
  - vivo：`com.vivo.permissionmanager.activity.BgStartUpManagerActivity`
  - ColorOS：`com.coloros.safecenter.permission.startup.StartupAppListActivity`
- **OriginOS 6 特有**：必须在「设置 → 电池 → 更多设置 → 智能后台冻结」把 App 加入「不受冻结影响」，**且需重启手机生效**。即使开了自启动和白名单，不关这个，闲置约 3 分钟照样休眠。这条必须写进引导页。

**用户层**（一次性手工清单，写进 QUICKSTART）
- vivo：后台高耗电允许、自启动、加速白名单、关联启动、电池优化=不优化、多任务界面加锁。
- ColorOS：自启动管理、纯净后台、多任务加锁、电池不优化。
- 均为厂商 UI 路径，随版本变动，文档标注"以实机为准"。

**兜底**：即使保活失败也不算灾难——tmux 里的 Agent 照跑，微信 iLink 通道（F-22，已上线）本身就能当一条独立的结果通知通路。文档里明确写这条降级路径。

### 6.9 构建与发布

**工具链**（当前主机：Debian 13，有 JDK 21 + Docker 29.8，**无 Android SDK / Gradle / adb**）

- 按「能 Docker 不破坏原生环境」：Docker 镜像内置 Android SDK（基于 `eclipse-temurin:21-jdk` + cmdline-tools + `platforms;android-36` + `build-tools;36.0.0`）。Gradle 用 wrapper 自带，与 JDK 21 兼容。
- 主机只装 `android-tools-adb`（极小）用于 `adb install` 和抓日志——USB 设备访问在容器里做很别扭，这部分留在主机更实际。
- Android 工程放**本仓 `android/`**（与 `frontend/` 平级），不进独立仓库——它和前端产物是同一个版本节奏。

**签名与分发**
- `release.keystore` 生成后**放在仓外**，`.gitignore` 排除 `*.keystore` / `android/local.properties` / `android/app/build/` / `android/build/` / `android/.gradle/` / `android/app/release/`。
- 仓库是开源的（`librae8226/nexus4cc`），因此：CI 只构建 **debug APK** 作为 artifact；**release APK 由维护者本地签名**后传到 GitHub Release，签名密钥不进 CI secrets。
- 目前 `.github/` 下没有任何 workflow，需要新建。

**版本同步**（现有规则要求 `package.json` + `frontend/package.json` + git tag 三处一致）
- 不手工维护第四处：在 `android/app/build.gradle` 里**读 `../package.json` 的 version 生成 `versionName`**，`versionCode` 取 `git rev-list --count HEAD`（单调递增）。
- 这样 `android/` 无需人工改动，现有发布流程（`docs/CLAUDE.md` 版本管理节）保持不变，只需在文档表格里补一行说明"Android 自动跟随"。

---

## 7. 里程碑

**排序原则：先退掉最大的未知。** M0 就打通「WebView + CORS + base-URL」这条全链路——它要是走不通，后面所有原生能力都是空中楼阁。

| 里程碑 | 内容 | 真机可演示的产物 |
|---|---|---|
| **M0 骨架** ⭐ | Docker 构建环境；`npx cap add android`；base-URL 抽象 + profile 设置页；服务端 CORS；SW 停用；`androidScheme: 'http'` | **能装、能登录、能连、终端可交互的 debug APK**。风险最大，价值也最大 |
| **M1 适配** | 安全区；返回键；外链出浏览器；剪贴板；折叠屏 `configChanges`；`matchMedia` 收敛；两台真机各跑一遍 | 体验上"像个正常 App"的 APK |
| **M2 通知** | 服务端 `/ws/monitor` + `monitors` 集合；原生前台服务；通知渠道；点击跳转；设置项 | **锁屏收通知**——App 存在的核心理由 |
| **M3 输入** | 语音识别；相机/相册；SAF 保存；`ACTION_SEND` 接收 | 走路/拍照/分享三条链路可用 |
| **M4 安全** | 生物识别解锁；Keystore 加密存储；桌面快捷方式 | token 不再明文落盘 |
| **M5 发布** | 签名；版本自动同步；CI debug 构建；README/QUICKSTART/ROM 引导页；GitHub Release | 可交付的 v1 APK |

每个里程碑独立提交、独立可演示，不攒大版本。

---

## 8. 验收与验证

**构建与安装**
```bash
# 构建（容器内）
docker run --rm -v $PWD:/app -w /app nexus-android-build ./gradlew assembleDebug
# 安装（主机）
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

**逐项验收**

| 需求 | 验证方法 |
|---|---|
| F-23.1 多 profile | 建 3 套地址，逐一连接；杀进程冷启动，确认恢复上次选择 |
| F-23.2 通知 | 真机启动一个长任务 → 息屏 → 计时等通知 → 点击验证落到正确窗口；再跑「思考 3 分钟」的用例确认**不误报** |
| F-23.3 语音 | 中文口述含标点的句子，检查终端内容无重复字（对照已知的 xterm 双提交缺陷） |
| F-23.4 相机 | 拍照 → 计时直到路径出现在终端；服务端确认 `data/uploads/今天/` 有文件 |
| F-23.5 分享/SAF | 从相册「分享到 Nexus」；在终端 `ls` 一个大文件后保存到 Download |
| F-23.6 生物识别 | 关闭指纹验证进不去；`adb shell run-as <pkg> grep -r "eyJ" .` 应搜不到 JWT 明文 |
| F-23.7 快捷方式 | 长按图标 → 点快捷方式 → 直达指定项目 |
| F-23.8 折叠屏 | X Fold6 开合 10 次，全程 WS 不断（`adb logcat` 确认无 Activity 重建）；刘海区域无遮挡 |

**调试手段**
- `chrome://inspect`（release 构建已关调试，用 debug 包）
- `adb logcat -s Nexus:* Capacitor:*`
- 后台被杀：手动「一键加速」+ `adb shell am kill <pkg>` 双路径验证
- 功耗：`adb shell dumpsys batterystats --charged <pkg>`

---

## 9. 风险与对策

| # | 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|---|
| R1 | **国产 ROM 保活失败**，通知不可靠 | 高 | 高（核心价值受损） | 代码层做满 + 引导页 + 微信通道兜底（§6.8） |
| R2 | `androidScheme: 'http'` 或 CORS 组合在某台机器上不通 | 中 | 高（阻断 M0） | **M0 第一个验证**，不通过则回退 `https` 壳 + 要求所有 profile 走 TLS |
| R3 | WebView 里 xterm 的 IME / 语音行为与 Chrome 有差异 | 中 | 中 | 已有 `mobileInput.ts` 三重守卫；语音改走原生识别，绕开 IME 通路 |
| R4 | Capacitor 8 与某些插件版本不兼容 | 中 | 中 | 不兼容即降级为自研 Kotlin（§6.6 已给路径），不影响架构 |
| R5 | 折叠屏开合重建 Activity 丢连接 | 中 | 中 | `configChanges` 显式声明 + 真机开合测试作为验收项 |
| R6 | 构建工具链进不去（无 SDK/Gradle） | 低 | 中 | Docker 镜像化，M0 第一件事就是把它跑通 |
| R7 | 后台常驻功耗超预期 | 低 | 中 | 单连接 + 事件驱动，无轮询；`dumpsys batterystats` 实测 |

**退路**：若 Capacitor 在某处硬伤且无法绕过，**换壳成本可控**——`frontend/dist` 产物和 base-URL 抽象层完全复用，只需用裸 Kotlin + WebView 重写桥接层。这是选 Capacitor 时保留的期权。

---

## 10. v1 明确不做（Scope 纪律）

- 手机本机跑服务端（§2.2 已论证硬约束）
- iOS
- 桌面小组件（P1）、通知快捷回复（P1）
- 多主机同时连接
- 离线模式 / 本地缓存会话
- FCM 推送、OTA 自更新
- 平板/横屏专属布局
- 传感器、定位、NFC、短信

---

## 11. 决策记录

| 日期 | 决策 | 结论 |
|---|---|---|
| 2026-10-02 | 服务端位置 | 仅远程客户端；不做本机模式 |
| 2026-10-02 | 壳框架 | Capacitor（Android only），否决 Tauri / 裸 Kotlin / Flutter / TWA |
| 2026-10-02 | 网络路径 | 多 profile 可切换，覆盖局域网 / Tailscale / Cloudflare Tunnel |
| 2026-10-02 | v1 能力范围 | 四类全要：后台常驻+通知、语音、相机/相册+SAF+分享、生物识别+快捷方式 |
| 2026-10-02 | 通知实现 | 新增 `/ws/monitor` 事件流 + 原生前台服务；否决客户端轮询与字节流猜测 |
| 2026-10-02 | Android 工程位置 | 本仓 `android/`，版本号读 `package.json` 自动跟随 git tag |
