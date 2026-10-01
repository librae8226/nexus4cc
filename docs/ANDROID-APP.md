# ANDROID-APP.md — Nexus Android 客户端（需求 + 技术方案）

**锚点**: `docs/NORTH-STAR.md` | **状态**: M0 代码侧完成，待真机裁决 | **更新**: 2026-10-02

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
| G5 | 启动需指纹/人脸解锁，无凭据不可进入 | 见 §8 |
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
| **F-23.6** | 生物识别门禁 | 冷启动/回前台需指纹或人脸解锁（允许设备 PIN 回退）；JWT 仍由 WebView 沙箱承载，**v1 不做 Keystore 迁移**（理由见 §10） | 关闭指纹则无法进入；多任务卡片里不泄漏终端内容 |
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
- **Token**：v1 加**生物识别门禁**（App 层面锁住），但不做 Keystore 加密存储迁移——见 §10 的理由。已知的"JWT 走 query string 可能进代理日志"问题在 APK 场景不变，属于服务端侧，不在本方案范围。
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

**改动 2 — `/ws/monitor` 结构化事件流（采样 tmux，不碰 PTY 层）**

这是通知能力的**关键设计决策**，先说为什么不能走别的路：

| 备选 | 问题 |
|---|---|
| 原生侧轮询现有 `/api/sessions/:id/output` | **该接口在没人附着时直接返回 `{connected:false, output:''}`**（读数来自 `ptyMap`，`server.js:1017-1029`），而 PTY 在最后一个客户端断开 5 分钟后被回收（`server.js:1730-1736`）。手机进后台正是"没人附着"的场景——也就是唯一需要它的场景，接口失效。且 `idleMs = now - lastActivity`，**Agent 思考 3 分钟和干完 3 分钟在这个信号上无法区分**。 |
| 原生侧解析终端字节流猜 | 脆、脏，且 Kotlin 侧要复刻一套启发式规则，规则改进得跟着发版。 |
| 在 `ptyMap` 上挂 `monitors` 集合并阻止回收 | 可行但更重：每个被监控的窗口都要永久养一个 `tmux attach` 客户端，且把监控耦合进了 PTY 生命周期（本该无关）。 |
| **`/ws/monitor` 服务端采样 tmux（选定）** | 服务端在**有 monitor 订阅者时**按 ~2s 周期跑 `tmux list-windows` + 每窗口 `tmux capture-pane -p -S -40`，把结构化状态推给订阅者。**完全不碰 `ptyMap`**，与 PTY 生命周期解耦，且对**从未在 Nexus 里打开过的窗口**同样有效。 |

采样版的具体好处：一条连接覆盖所有窗口（功耗 = 一个 keepalive，不是 N 个轮询）；判定逻辑留在服务端，**改启发式不用发 APK**；复用前端已有的 `frontend/src/windowStatus.ts` 规则，不重复造。

协议（服务端 → 客户端，JSON，只推状态不推内容）：

```json
{"type":"state","session":"main","window":2,"name":"api",
 "state":"running|needs_input|finished|shell|exited",
 "reason":"prompt_detected|quiet|hook|process_exit",
 "idleMs":9000,"since":1699999999000,"tail":"…最后若干非空行…"}
```

`reason` 字段从第一天就要留出来：Claude Code 有 `Stop` / `Notification` hooks，而 `nexus-run-claude.sh` 本来就包裹了每个 agent，将来可以注入生成的 `--settings` 让 hook 直接 `tmux set-option -w @nexus_state …`，把启发式升级成**精确信号**（v1.1，不作为 v1 依赖）。

**误报是这里的核心难点**，缓解手段按可信度排序：

1. **滞回 + 更长的静默阈值**。`QUIET_MS` 默认 10s（不是前端那套 4s），静默后才分类。
2. **内容匹配**：pane 尾部以 `>` / `?` 结尾 → `needs_input`（高置信）；以 `$` / `#` 结尾 → `shell`（任务结束）；其余静默 → `finished`（**低置信**）。
3. **只对高置信转移发通知**：`needs_input` 立即发；`finished` 需静默超过长阈值（如 120s）才发。这是抗误报最有效的一根杠杆。

延迟与功耗的取舍：2s 采样 + 静默阈值 ⇒ `needs_input` 最坏约 12s 送达。若要亚秒级，后面可换 `tmux -C` 控制模式（单进程流式事件，无轮询），但那是优化路径，不作为起点。

**改动 3 — 无。** 终端 WS 协议、`/api/*` 全部不动。

### 6.4 前端改动

**改动 A — base-URL 抽象（最大的必改项）**

现状是**没有任何"服务器地址"概念**：约 30 处相对路径 `fetch('/api/...')`，WebSocket 由 `location.host` 拼出（`Terminal.tsx:1485-1507`）。WebView 有自己的 origin，一装上就连不上。

**好消息：改动面比看上去小得多** —— 但**比本节初稿以为的多两处**（实施时审计出来的，见 §12）：

- 新增 `frontend/src/baseUrl.ts`，导出 `apiUrl()` / `wsUrl()` / `getApiBase()` / `getActiveProfile()` / `isNative()`，profile 列表存 `localStorage`（`nexus_profiles` / `nexus_active_profile`）。
- **零调用点改动**：`installRequestRewrite()` 在 bootstrap 时包一层 `window.fetch` **和 `XMLHttpRequest.prototype.open`**，只对匹配 `^\/(api|workspace)([/?]|$)` 的请求前缀 base URL；其余（打包资源、绝对 URL）原样放行。在 `main.tsx` 里于 `createRoot()` **之前**调用。
- WS 只改一处：`Terminal.tsx:1507` 换成 `wsUrl('/ws?token=…&window=…&session=…')`。
- **非 fetch 的 URL 拼装要单独处理**：`WorkspaceBrowser.tsx:603` 把 `/workspace?…` 塞进 `<a href>`，走的是浏览器导航而非 fetch，改写覆盖不到，必须显式过 `apiUrl()`。
- **浏览器/PWA 路径零影响**：无激活 profile 时 `getApiBase()` 返回 `''`，`apiUrl` 是恒等函数，行为与今天完全一致——**一个 bundle 同时服务浏览器和 App**。
- 权衡：包 `window.fetch` 是 monkey-patch，不如显式 `apiFetch()` 干净，但它把 30 处改动压到 1 处；这是刻意的取舍，需要在 `baseUrl.ts` 顶部注释说明原因。
- 地址设置界面**必须先于登录可达**（登录请求本身就是 profile 定向的）：`App.tsx` 登录页加一个服务器入口；native 且无 profile 时直接显示编辑器而不是登录表单。
- 登录后的切换入口**不进 `GeneralSettings`**。文档初稿写的是"放进设置面板（Restore 与 About 之间）"，M0 真机反馈推翻了它：设置面板本身就长到一屏放不下，再添一段只会让「设置」这个入口本身变难用。改为和「设置」**并列**的一项。
- **并列的具体落点取决于齿轮是哪一枚**，这一点必须对着真实 DOM 查，不能想当然：
  - 手机/折叠屏宽度（< 1024px）：那枚"齿轮"其实是 **「More ⋯」快捷菜单按钮**（图标恰好是 settings 齿轮），它开的是一个已经含「设置」项的列表 → 直接在里面加一项「服务器」即可，**再加一层菜单就成了「⋯ → 设置 → 设置」**。
  - ≥ 1024px 且侧边栏展开：Toolbar 的齿轮没有别的入口，才需要两栏菜单。
  - ≥ 1024px 且侧边栏折叠（默认）：侧边栏最底那枚齿轮 `title` 是 **"Session Manager"**，开的是会话管理器，与设置无关 —— 别改它。
- 因此 `SettingsMenu.tsx` 导出两个东西：`SettingsMenu`（齿轮 → 两栏菜单）与 `ServerPanel`（切换面板本体），各自挂在需要它的路径上。面板体复用登录页的 `ServerSettings`（`collapsible={false}`），profile 的增删改只存在一份。
- 切换 = 改激活 profile + **整页重载**（只换 base URL 会出现"新请求打新地址、旧 WS 还挂在老地址"的混合态）。
- 尚未做：**测试连通性**按钮（请求 `${url}/api/version`，401=可达、200=已认证）。原计划放在这里，实测发现终端本身就是最直接的连通性指示，暂缓到 M2。
- 顺带：30 天 JWT 无刷新、无过期 UI，长时间在后台的 App 迟早会静默 401。在 shim 里加一个最小的 401 处理（清 token、回登录）——直接由"应用常驻"这个新场景导致，见 §6.3 的同类判断。

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
| `server.androidScheme` | **待 M0 现场决策**（见下方专节） | 默认 `https`（→ origin `https://localhost`），此时请求 `http://192.168.x.x` / `http://100.x.x.x` 属混内容，需 `allowMixedContent: true`；改 `http`（→ `http://localhost`）则与 http profile 同 scheme，无混内容问题，且 `localhost` 两种 scheme 都是安全上下文 |
| `webContentsDebuggingEnabled` | debug 构建开，release 关 | `chrome://inspect` 调试 WebView 的唯一途径 |
| `configChanges` | 必须含 `orientation\|screenSize\|smallestScreenSize\|screenLayout\|density\|keyboardHidden\|uiMode` | **折叠屏开合 / 软键盘弹出 / 深浅色切换都不能重建 Activity**——重建就等于 WebSocket 断开、终端重排。这是 F-23.8 的技术根因。 |
| cleartext | 通过 `network_security_config.xml` 放行 | Capacitor 自带的 `cleartext` 选项文档明说"不用于生产"，因此不用它，改走标准网络安全配置 |
| `compileSdk` / `targetSdk` | 36 | Android 16 |
| `minSdk` | Capacitor 默认 | 两台测试机远超 |
| ABI | `arm64-v8a` 单 ABI（release） | 体积减半。debug 额外保留 `x86_64` 以便本机模拟器 |

**M0 必测：混内容与 `ws://`（本方案最大的单一未知）**

`androidScheme` 不是纸面选型，必须真机定夺，因为**两条路各有风险**：

| 路线 | 壳 origin | 优点 | 风险 |
|---|---|---|---|
| A. 默认 `https` + `allowMixedContent: true` | `https://localhost` | 用 Capacitor 默认值，不动 storage/cookie 行为 | `allowMixedContent` 文档标注"不用于生产"；且 **`ws://` 是否也被 MIXED_CONTENT_ALWAYS_ALLOW 放行，各 Chromium 版本处理不一致，未经验证** |
| B. `androidScheme: 'http'` | `http://localhost` | 与局域网/Tailscale 明文 profile 同 scheme，**根本没有混内容问题**；http 页请求 https 隧道地址也合法 | Capacitor 文档不推荐（可能影响 storage/cookie 语义）；未在这两台 ROM 上实测 |

**B 反而是主力场景（明文局域网/VPN）更稳的那条**，因为 `ws://` 从 https 页面发起属于混内容降级，历史上 Chromium 对它比对 `http://` XHR 更严——而混内容规则管的正是 XHR/WebSocket，不是页面里的绝对 URL。

**M0 的验收动作**：两条路线各跑一次「三套 profile 全连 + 终端可交互」，看 `chrome://inspect` 控制台的混内容报错。裁决顺序：

1. B 通 → 用 B。
2. B 不通 → A。
3. A/B 都不通（即 `ws://` 被硬拦）→ 退到「所有 profile 必须 TLS」：Tailscale 用 `tailscale serve`、隧道本来就 https、局域网自签证书。**这是唯一会让"局域网明文直连"这个便利性消失的结局，必须早发现。**

### 6.6 原生能力 → 实现路径

| 能力 | 方案 | 说明 |
|---|---|---|
| 前台服务 | **自研 Kotlin** `NexusMonitorService` + `NexusMonitorPlugin` | 没有任何插件提供"持有 WS + 跑状态机 + 发通知"这件事。参考壳：`@capawesome-team/capacitor-android-foreground-service` 8.1.0，它只管理服务与常驻通知，socket 仍要自己写。用 `specialUse` 类型（Android 16 上 `dataSync` 受 6h/24h 配额限制且不能从 `BOOT_COMPLETED` 启动；`specialUse` **无时限**；App 侧载，不涉及 Play 审核） |
| 通知 | `@capacitor/local-notifications` 8.x + 自研渠道 | 需要自建渠道、点击意图携带 `session/window` 以便跳转 |
| 语音识别 | ⚠ `@capacitor-community/speech-recognition` 7.0.1 **或** 自研 `RecognizerIntent` 插件 | 前者走 Android `SpeechRecognizer`；**但国产 ROM 常常没有 Google 语音引擎，`available()` 可能直接为 false**。自研版调 `RecognizerIntent.ACTION_RECOGNIZE_SPEECH`（系统选择器，用 OEM 自带 ASR）更可移植。**预期自研版才是最终答案，M4 真机定** |
| 相机 / 相册 | `@capacitor/camera` 8.2.4（官方） | 输出直接喂给 `Terminal.tsx:875` 附近的**现有上传队列** `enqueueFiles`，它已经在调 `POST /api/files/upload`。**复用现有通路，服务端零改动**。优先 `CameraSource.Photos`（系统选择器，免 `CAMERA`/`READ_MEDIA_IMAGES` 权限），仅拍照时申请 `CAMERA` |
| 文件选择 | `@capawesome/capacitor-file-picker` 8.1.0 | 返回 content URI + base64/dataUrl，同样进现有上传队列 |
| 文件保存到手机 | **自研 Kotlin** `NexusSafPlugin`（`ACTION_CREATE_DOCUMENT` / `CreateDocument`） | `@capacitor/filesystem` 走的是 app 作用域/legacy 路径，在 Android 11+ 分存储下**不是真 SAF**，写公共目录要 `MANAGE_EXTERNAL_STORAGE`（更糟）。既然 P0 写的是 SAF，就用文档选择器做对 |
| 接收系统分享 | **自研 Kotlin** `NexusSharePlugin` | 没有在维护的 share-receive 插件（`@capawesome/capacitor-share-target` 在 npm 上 404）。需 `ACTION_SEND` / `ACTION_SEND_MULTIPLE` intent-filter + 自定义 `MainActivity.onNewIntent` |
| 生物识别 | `@aparajita/capacitor-biometric-auth` 10.0.0 | `verifyIdentity()` 支持设备凭据回退；`@capacitor-community/biometric-auth` 在 npm 上不存在。用一个 React 覆盖层挡在整棵树前面，通过后才渲染 |
| 安全存储 | **v1 不做**，仍用 `localStorage['nexus_token']` | WebView 的存储本来就沙箱在 app 内；`@capacitor/preferences` **不加密**，等于白搬。真加密要走 Keystore（`EncryptedSharedPreferences`）自研插件 + 认证流程重构。**M0-M3 先靠生物识别门禁，M4 视工时决定是否拆分**，见 §10 |
| 桌面快捷方式 | `@capawesome/capacitor-app-shortcuts` 8.0.2 | （`android-shortcuts` 已改名，现役包是 `app-shortcuts`）。登录后按项目注册动态快捷方式，`nexus://open?project=…`，用 `@capacitor/app` 的 `appUrlOpen` 接收 |
| 返回键 / 外链 / 剪贴板 | `@capacitor/app` + 自研 | 外链必须出到系统浏览器（`WebLinksAddon` 现在强制 `window.open`，`Terminal.tsx:1012-1016`），否则会在 WebView 里打开或静默失败 |

> 包名与版本号已在 2026-10-02 对过 npm。**Capacitor 各包必须锁在同一 major**——注意 `speech-recognition` 还在 7.x 而 core 是 8.x，这类错位要在各自里程碑里冒烟测一遍。不兼容的直接降级为自研 Kotlin，路径已在表中给出。

自研插件的落点（新建文件）：

```
android/app/src/main/java/<appId>/
  NexusMonitorPlugin.kt    // @CapacitorPlugin(name="NexusMonitor"): start({baseUrl,token}) / stop() / getSnapshot()
  NexusMonitorService.kt   // 前台服务 + OkHttp WebSocket → /ws/monitor + 状态机 + 通知
  NexusSafPlugin.kt        // saveAs({filename,mime,dataBase64}) → ACTION_CREATE_DOCUMENT
  NexusSharePlugin.kt      // getPendingShare() / notifyListeners("shareReceived", …)
  MainActivity.kt          // onCreate / onNewIntent，把 ACTION_SEND 转给 NexusSharePlugin
  NotificationChannels.kt
android/app/src/main/res/xml/network_security_config.xml
```

### 6.7 通知判定与防打扰

判定逻辑在**服务端**（§6.3），Kotlin 侧只做"收到状态转移 → 决定是否通知"，不重复实现启发式。

**必须是边沿触发，不是电平触发**：只在**进入** `needs_input`（高置信，立即发）或 `finished`（需静默超过长阈值，默认 120s）或 `exited` 时通知，**绝不对 `running` 发**。

抑制规则（防刷屏）：

1. 该窗口需先 `running` 满 N 秒才具备 `finished` 通知资格——避免 `ls` 跑 2 秒也弹通知。
2. 只对**用户订阅的窗口**发（默认当前项目的频道）。
3. 同窗口冷却：距上次通知 < 5 分钟不发。
4. **App 在前台时全部抑制**（用 `ProcessLifecycleOwner` 判断）——UI 上已经能看到同样的状态，弹通知是噪音。
5. 多窗口同时触发 → 合并成一条摘要通知（"2 个 Agent 需要输入"）。
6. 主开关 + 单窗口静音。

通知内容：项目/窗口名 + 最后一行非空输出摘要；点击经 `nexus://open?project=…&window=…` 深链直达（与桌面快捷方式共用一套管线）。渠道分两条：`nexus_agent`（默认重要性，可被用户静音）与 `nexus_service`（低/最低，前台服务常驻通知）——**用户静音前者不会杀掉后者**。

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

**签名**（已实施，2026-10-02）
- `android/keystore/nexus-release.jks`（RSA 4096，有效期 10000 天 → 2054）+ `android/keystore.properties`（0600），两者均 0600 且已 gitignore（`.gitignore:37-38`）。
- `android/app/build.gradle` 在 `keystore.properties` **存在时**才注册 `signingConfig`；不存在时 release 任务**直接抛错**，不静默产出未签名包（那种包装不上，且报错离原因很远）。新克隆的仓库因此仍能构建 debug 包，CI 不需要签名密钥。
- 签名方案：**仅 v2**。minSdk 24 = Android 7.0 起支持 v2，v1（JAR）无必要；未启 v3（密钥轮换）—— 侧载场景不需要。
- **WebView 远程调试在 release 包里自动关闭**：Capacitor 的 `android.webContentsDebuggingEnabled` 默认跟随 `FLAG_DEBUGGABLE`（`CapConfig.java:286`），无需额外配置。debug 包照常可以 `chrome://inspect`。
- **不开 R8/minify**：包体大头是 `frontend/dist`（Vite 已压过），Java 侧只剩 Capacitor 桥和几行 `MainActivity`，混淆省不下多少，却可能裁掉反射用到的东西。
- 体积：release **3.40 MB** vs debug 4.39 MB。
- ⚠️ **密钥必须仓外备份**（keystore + properties 两者缺一不可）。丢了就再也无法更新已安装的 App —— 不是"重新签一个"能解决的。
- ⚠️ **release 与 debug 签名不同**，覆盖安装会被系统拒绝；装 release 必须先卸载 debug 包，**App 数据（服务器 profile、登录态）会一并清空**。
- `.gitignore` 追加：`android/.gradle/`、`android/build/`、`android/app/build/`、`android/app/release/`、`android/local.properties`、`android/keystore/`、`android/keystore.properties`、`**/*.jks`、`**/*.keystore`。

**版本同步**（现有规则：git tag 是唯一事实源，`package.json` + `frontend/package.json` 必须同步）
- **Android 不做第四处手工维护，而是派生消费**。`android/app/build.gradle`：
  ```gradle
  def pkg = new groovy.json.JsonSlurper().parseText(file('../../package.json').text)
  def (maj, min, pat) = pkg.version.tokenize('.').collect { it as int }
  android { defaultConfig {
    versionName pkg.version
    versionCode maj * 10000 + min * 100 + pat   // 4.8.6 -> 40806
  } }
  ```
- 于是现有发布流程（改两个 `package.json` → commit → tag）**自动产出正确版本的 APK**，不新增手工步骤。⚠ 预发布后缀（`4.9.0-rc1`）会让 `as int` 抛错，若将来要用需加保护。
- `CLAUDE.md` 的版本管理表补一行说明「Android 自动派生」，`docs/PRD.md` / `docs/ROADMAP.md` 补新交付渠道。

---

## 7. 里程碑

**排序原则：先退掉最大的未知，再谈功能。** 两个未知最贵——混内容/`ws://` 能否走通（决定整个网络方案），以及国产 ROM 是否允许前台服务存活（决定通知功能存不存在）。两者都用最小成本先测，测完再投入。

| 里程碑 | 内容 | 真机可演示的产物 |
|---|---|---|
| **M0 全链路裁决** ⭐ | Docker SDK 镜像；`cap init` + `cap add android`；服务端 CORS 中间件；SW 停用；profile 先硬编码；**三套 profile × 两种 `androidScheme` 实测**（§6.5） | **能登录、能看到 tmux 终端、能敲键**的 debug APK。**本方案风险最高的一步** |
| **M1 保活风险探针** ⭐ | 一个最小 `NexusMonitorService`：持有长连接，每 10 分钟发一条哑通知。跑一遍 §8 的杀后台矩阵 | 是否需要"省电模式"、以及 FGS 到底能不能活下来**的实测答案**。**在写监控逻辑之前先知道这个** |
| **M2 多 profile + 适配** | `baseUrl.ts` shim；登录页服务器入口；`GeneralSettings` 编辑器；安全区 + `viewport-fit: cover`；返回键/外链/剪贴板；折叠屏 `configChanges` 实测 | 不重新构建就能在局域网↔Tailscale↔隧道之间切；折叠屏开合不断连 |
| **M3 原生 I/O** | 相机/相册 → 现有上传队列；SAF 保存；`ACTION_SEND` 接收 | 从系统相册「分享到 Nexus」→ 上传 → 路径出现在终端 |
| **M4 语音 / 门禁 / 入口** | 语音识别（先试社区插件，不行就自研）；生物识别覆盖层；桌面快捷方式 | 说一句话进终端；没指纹进不去；长按图标直达项目 |
| **M5 监控与真通知** | 服务端 `/ws/monitor` tmux 采样 + 状态机；通知渠道；防刷屏；深链 | 切后台跑任务，**在需要输入时收到通知**并点击直达 |
| **M6 保活引导 + 发布** | ROM 引导页与 intent 跳转；签名；版本派生；CI debug 构建；README/QUICKSTART；GitHub Release | 两机过夜存活 + 从 tag 可复现地产出签名 APK |

每个里程碑独立提交、独立可演示。M1 是刻意插在 M2 之前的"廉价探针"——它不含任何产品功能，但它的结论会决定 M5 怎么做。

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
| F-23.4 相机 | 拍照 → 计时直到路径出现在终端；服务端确认当前工作目录下有该文件 |
| F-23.5 分享/SAF | 从相册「分享到 Nexus」；在终端 `ls` 一个大文件后保存到 Download |
| F-23.6 生物识别 | 关闭指纹验证进不去；指纹与 PIN 回退两条路都试；验证覆盖层不能一闪而过（要挡住首帧内容） |
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
| R1 | **`ws://` 明文 WebSocket 被混内容策略拦住** | 中 | 高（可能逼所有 profile 上 TLS） | **M0 用两种 `androidScheme` 各测一次**（§6.5）。退路：`androidScheme:'http'` → 全 profile TLS（Tailscale `tailscale serve` / 隧道 / 自签）|
| R2 | **国产 ROM 保活失败**，通知不可靠 | 高 | 高（核心价值受损） | **M1 独立探针先测**，不留到 M5；代码层做满 + 引导页 + 微信通道兜底（§6.8） |
| R3 | **vivo/OPPO 无 Google 语音引擎**，社区插件直接不可用 | 高 | 中 | 预期自研 `RecognizerIntent` 插件才是最终形态（§6.6）；终极兜底是键盘自带的语音听写，它本来就能通过隐藏 textarea 工作 |
| R4 | WebView 里 xterm 的 IME 行为与 Chrome 有差异 | 中 | 中 | 已有 `mobileInput.ts` 三重守卫，且双提交守卫被 `innerWidth >= 1024` 限死、手机上不生效；语音改走原生识别绕开 IME 通路 |
| R5 | 折叠屏开合重建 Activity 丢连接 | 中 | 中 | `cap add android` 后**核对**生成的 `configChanges` 是否含 `screenSize\|smallestScreenSize\|screenLayout\|keyboardHidden\|keyboard`，缺则补；真机开合 10 次作为验收项 |
| R6 | Capacitor 各包版本错位（core 8.x vs speech 7.x 等） | 中 | 中 | 锁同一 major；每个插件在所属里程碑冒烟测；不兼容即降级自研 Kotlin（§6.6 已给路径） |
| R7 | 服务端启发式误报（把"思考中"当"干完了"） | 中 | 中 | 滞回 + 内容匹配 + **只对高置信转移通知**；`reason` 字段预留，v1.1 接 Claude Code hooks 拿精确信号（§6.3） |
| R8 | 构建工具链进不去（无 SDK/Gradle/adb） | 低 | 中 | Docker 镜像化，M0 第一件事；主机只留 `android-tools-adb` |
| R9 | 后台常驻功耗超预期 | 低 | 中 | 单连接 + 服务端采样（无 N 路轮询）；提供"省电模式"降级为 30-60s 间隔拉取；`dumpsys batterystats` 实测 |

**两个诚实的边界**（写进文档，别让未来的自己以为是 bug）：

- `am force-stop` / 「强制停止」之后，**任何 App 都无法自启**，这不是缺陷。
- 息屏深度 Doze 下 FGS 的网络是否受限，未在 OriginOS 6 / ColorOS 16 实测——列为 M1/M6 的测量项，不是假设。

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
- **Keystore 加密存储迁移**。WebView 的存储本来就沙箱在 app 私有目录内；`@capacitor/preferences` 不加密等于白搬，真加密要走 `EncryptedSharedPreferences` 自研插件 + 认证流程重构。**收益是「拿到已 root/已解锁设备的人更难提取 token」，成本是一个插件加一轮认证改造**。v1 用生物识别门禁挡住绝大多数场景，这条留到 M4 视工时决定是否拆出。
- **把遗留的 `window.resize` 监听改成 `matchMedia`**（`SessionManager.tsx`、`WorkspaceSelector.tsx`、`Toolbar.tsx`、`SessionFAB.tsx`）。`Terminal.tsx` 已经用 `matchMedia` 规避了折叠屏 resize 不可靠的问题，这几个是 lazy 加载的遗留面板——**只在折叠屏实测确实出问题时才改**，否则是无谓改动。
- **Claude Code hooks 精确状态**（§6.3 的 `reason: "hook"`）。协议字段现在就留，实现放 v1.1。
- **401 / token 刷新 UX**。v1 复用现有的重连失败提示即可。

---

## 11. 决策记录

| 日期 | 决策 | 结论 |
|---|---|---|
| 2026-10-02 | 服务端位置 | 仅远程客户端；不做本机模式 |
| 2026-10-02 | 壳框架 | Capacitor（Android only），否决 Tauri / 裸 Kotlin / Flutter / TWA |
| 2026-10-02 | 网络路径 | 多 profile 可切换，覆盖局域网 / Tailscale / Cloudflare Tunnel |
| 2026-10-02 | v1 能力范围 | 四类全要：后台常驻+通知、语音、相机/相册+SAF+分享、生物识别+快捷方式 |
| 2026-10-02 | 通知实现 | 新增 `/ws/monitor`，**服务端采样 tmux**（非挂 `ptyMap`）+ 原生前台服务；否决客户端轮询 `/api/sessions/:id/output`（无人附着时该接口失效）与客户端字节流猜测 |
| 2026-10-02 | `androidScheme` | **不在文档里拍板**，M0 两种方案真机裁决（`ws://` 混内容行为未经验证） |
| 2026-10-02 | Token 安全 | v1 做生物识别门禁，**不做 Keystore 存储迁移**（§10） |
| 2026-10-02 | Android 工程位置 | 本仓 `android/`，`versionName`/`versionCode` 从 `package.json` 派生，无需手工维护 |
| 2026-10-02 | 里程碑排序 | M0 全链路裁决 → **M1 前台服务保活探针**（先于一切功能）→ M2…M6 |

---

## 12. M0 实测记录（2026-10-02）

代码侧已完成并提交，真机部分待设备。

### 12.1 计划中被实施推翻的四处

| # | 初稿说法 | 实施时的事实 | 影响 |
|---|---|---|---|
| 1 | 全前端网络出口只有「约 30 处 fetch + 1 处 WebSocket」 | **还漏了两处**：`Terminal.tsx:848` 的上传队列走 `XMLHttpRequest`（需要 `xhr.upload.onprogress`，所以当初没用 fetch）；`WorkspaceBrowser.tsx:603` 把 `/workspace?…` 拼进 `<a href>`，走浏览器导航 | 前者靠包 `XMLHttpRequest.prototype.open` 覆盖，仍是零调用点改动；后者必须显式 `apiUrl()`。**只按初稿做，拍照上传和文件打开都会在 APK 里静默失效** |
| 2 | fetch 调用数「约 30 处」 | 实际 55 处 fetch + 1 处 XHR | 只影响估算，结论不变 |
| 3 | `configChanges` 需人工核对、可能要补（风险 R5） | Capacitor 模板**已经**带全：`configChanges=0x1ff4`，含 orientation / screenSize / smallestScreenSize / screenLayout / density / keyboardHidden / uiMode | R5 自动消解，无需改动 |
| 4 | 自研插件落点写成 `MainActivity.kt` | Capacitor 生成的是 **Java** 的 `MainActivity.java`，工程未启用 Kotlin 插件 | M1 加自研 Kotlin 前要先给 `android/app/build.gradle` 加 Kotlin Gradle 插件，或把 `MainActivity` 保持 Java 只新插件用 Kotlin |

### 12.2 构建工具链的两个坑（都已解决）

- **`build-tools;35.0.0` 必须预装**。项目里没有任何地方声明它 —— 是 AGP 8.13.0 自带的默认 `buildToolsVersion`，对每个 subproject 生效，与 `compileSdk=36` 无关。不预装的话 Gradle 会在运行期尝试下载，而那时容器以宿主 uid 运行、对 `/opt/android-sdk` 无写权限，报错是极具误导性的 `The SDK directory is not writable`。
- **`build-apk.sh` 里 `cap sync` 不能省**。漏掉就是「改了前端、APK 里还是旧界面」，且**没有任何报错**。

### 12.3 已验证（不需要真机）

| 项 | 方法 | 结果 |
|---|---|---|
| CORS 中间件行为 | 从 `server.js` 抽出真实代码块挂到哑 express 上跑 | 13/13 |
| base-URL 改写 | `baseUrl.ts` 编译后在 polyfill 的浏览器环境里跑 | 30/30 |
| **跨源全链路** | 真实浏览器：origin A 伺服真实 `frontend/dist`，origin B 提供真实 CORS 中间件 + 真实 bcrypt/jwt 登录 | 9/9 |
| 版本派生 | `aapt2 dump badging` 读构建产物 | `4.8.6` / `40806` |
| 清单与资源 | 同上 | `networkSecurityConfig` 生效、`configChanges=0x1ff4`、web 资源就位 |

跨源那条带**反面对照**：不配 profile 时登录必须失败。否则无法排除「成功是因为恰好同源或别的巧合」。

### 12.4 待真机裁决（M0 剩余部分）

| 未知 | 怎么测 | 决定什么 |
|---|---|---|
| `androidScheme: 'http'` 下明文 profile 能否连通 | 装上 APK，配局域网 profile，登录 + 终端可交互 | 主力场景是否成立 |
| `ws://` 是否被混内容策略拦截 | 同上，看终端能否真的连上（登录成功不代表 WS 成功） | 若被拦，退到全 profile TLS |
| 同一套流程换 `androidScheme: 'https'` + `allowMixedContent` | 改 `capacitor.config.json` → `cap sync` → 重新构建 | A/B 二选一 |
| 折叠屏开合不断连 | X Fold6 开合 10 次 | F-23.8 |

**前置**：服务端 `.env` 要有 `CORS_ORIGINS=http://localhost,https://localhost` 并重启 —— 当前**未设置**，不设置的话 APK 连不上，且表现为没有线索的「连接失败」。

### 12.5 构建产物

- `android/app/build/outputs/apk/debug/app-debug.apk`，4.39 MB
- minSdk 24 / targetSdk 36 / compileSdk 36，唯一权限 `INTERNET`
- 构建命令：`android/build-apk.sh`（Docker 内置 Android SDK，宿主机零污染）
