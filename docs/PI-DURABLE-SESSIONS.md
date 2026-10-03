# PI-DURABLE-SESSIONS — Nexus 作为 pi-durable 前端（持久化 pi 会话）

**创建**: 2026-10-04（L16 提出并拍板登记）  **状态**: 待办（已登记，未开工）
**锚点**: `docs/NORTH-STAR.md`  **关联**: `docs/SESSION-PERSISTENCE.md`、`docs/ROADMAP.md`、pi 集成 `851956f`、pi-durable（`~/work/pi-durable/README.md`）

> 一句话：Nexus 创建 pi 窗口时**勾上「持久会话」** = 挂到 pi-durable 服务器上的持久会话——
> 关窗口、断线、宿主机重启都不丢，随时从 Nexus 或终端挂回来；不勾 = 现状的普通 pi 窗口。
> （L16 2026-10-04 拍板：两种形态的 UI 差别**就是一个勾选框**。）

---

## 1. 前因（为什么有这条需求）

1. **2026-10-04** pi-durable 上线：PM2 服务 `pi-durable`，会话（对话 + 在飞任务 + 状态）跑在服务器端、worker 独立进程、崩溃可恢复；目前**只有终端入口**（`pi-durable attach`），没有 UI。四种故障场景（客户端死 / worker kill -9 / server kill -9 / 宿主机重启路径）已实测不丢数据，见 `~/work/pi-durable/README.md`。
2. Nexus 已有**普通 pi 类型**（`851956f`，第三种 shell type）：每个窗口一个前台 pi 进程，走独立 agent dir `~/.pi/agent-nexus`（多 profile：kimi / openrouter 等可切换）。
3. 两种形态的差别（L16 与 Rich 讨论后确认的心智模型）：
   - **普通 pi = 一次性**：窗口是进程的容器，窗口/宿主机没了就没了（恢复链目前只把窗口恢复成空 shell，见 `SESSION-PERSISTENCE.md §6.2`）。
   - **pi durable = 持久**：会话在服务器上，终端/窗口只是"遥控器"；遥控器怎么坏，会话都在。
4. **缺口**：L16 想在 Nexus（含手机端）里直接启动**持久化 pi agent**——丢个长任务、关掉走开、回头（哪怕换过设备、重启过主机）还能挂回来接着聊。现在这一步只能在终端做。
5. 架构定位（讨论结论，供后来者对齐）：
   - durable 不是 tmux 的替代，也不是 Nexus 的同层替代——它是**「pi 的另一个容身层」，与 tmux 并列**（tmux 装任意进程，durable 只装 pi 持久会话）；
   - Nexus 是前端。本需求 = 让 Nexus 认得并启动这类"窗口"。

## 2. 需求（做什么）

**Nexus 的 pi 类型加一个「持久会话」勾选项（= pi-durable 前端）；勾与不勾，就是创建窗口时一个勾的区别：**

0. **UI 形态（L16 拍板）**：不新增并列类型，就在现有 pi 类型上加一个勾选框——**勾选「持久会话」→ 窗口挂 pi-durable（持久保护）；不勾 → 现状的普通 pi 前台进程**。
1. **窗口启动**：勾选时，窗口里运行的不是 pi 本体，而是 `~/.local/bin/pi-durable attach …`（挂载客户端）。
2. **窗口 ↔ 会话语义**：
   - 默认：新窗口 = 新会话；
   - 续接：支持"续最近会话"（`pi-durable -c`）与"挂指定会话"（`--session-id <id>`）；
   - UI 形态待定（创建对话框选项 / 窗口内命令 / 会话列表任选或组合）。
3. **会话列表**（可选增强，二期）：Nexus 侧列出 durable 会话（`pi-durable ls`，非 TTY 模式）并点选挂入。
4. **宕机恢复链适配（必做）**：宿主机重启后，该类型窗口的恢复 = 重新执行 attach 命令（会话本来就在 server 端，恢复成本远低于普通 pi）。注意：恢复链目前只认 `nexus-run-claude.sh` 拉起的 claude 频道，**pi 频道现在重启后会退化成普通 shell**（无 `nexus-resume-pi.sh`）——本需求顺带把**两类 pi 频道**的恢复一起纳入。
5. **模型 / profile**（设计点，二期）：durable server 端目前只有 DeepSeek 凭据；Nexus 的 profile 体系（`~/.pi/agent-nexus` 按 profile 生成 models.json）作用于 client 侧，**对 durable 会话不生效**（模型/凭据解析发生在 server 端）。二期选项：每会话 `/model` 切换、per-profile server 实例、或 server 端多 profile 支持。

## 3. 技术草图（参考实现路径）

- **Launcher**：仿 `nexus-run-pi.sh` 增加 `nexus-run-pi-durable.sh` → `exec ~/.local/bin/pi-durable attach "$@"`。无需像普通 pi 那样生成 profile 的 models.json（pi-durable 自带 `PI_EXPERIMENTAL=1` 与凭据封装）。
- **后端**：`server.js` 的 shell_type 四处 call site（windows / sessions / projects / channels）——"pi" 分支里接受持久标记，映射到上面两个 launcher 之一。
- **前端**：`NewWindowDialog` / `WorkspaceSelector` 的 pi 选项下加「持久会话」勾选框（不新增并列 radio）；勾选状态随创建请求传给后端，locale 加对应文案。
- **会话列表解析**：`pi-durable ls` 输出 `serverId<TAB>sessionId` 两列；注意 pi 系命令在管道 stdin 下会挂起，pi-durable 包装器已处理（`</dev/null`）。
- **窗口命名**：可选把 session id 短号写进窗口名，方便恢复与对账。
- **手机端**：前端改动与 `851956f` 同路径（勾选框 / locale / 类型透传），不涉及原生层；上线时可随 Android「实时加载」机制（2026-10-04 L16 拍板的改造，web 改动免重打包）下发，勾选框本身不需要为新 APK 而等打包。

## 4. 验收标准

1. Nexus 里创建「pi（持久）」窗口 → 丢一个长任务 → 关闭窗口 / 断开 Nexus → 重开并挂回该会话，任务已继续（或仍在跑）；
2. 宿主机重启后，同一会话可从 Nexus 挂回；
3. 普通 pi / claude / bash 类型不受影响，所有类型并存；
4. 恢复链重启后，不把「pi（持久）」窗口退化成空 shell（普通 pi 频道一并做到）。

## 5. 边界、依赖与风险

- **依赖**：pi-durable 服务器在线（PM2 `pi-durable`，已配开机自启）；上游为 experimental，钉 pi `v1.0.1`，升级流程见 pi-durable README。
- **NORTH-STAR 对齐**：不替换 tmux 原则不受影响——窗口仍由 tmux 承载，durable 只是"窗口里的进程类型"之一；本需求增强「极致 Agent 管理 / 抗宕机」轴。
- **风险**：attach 是 TUI，渲染与普通 pi 窗口无异（本质都是 tmux 窗口里的 TUI）；server 离线时该类型窗口打不开，错误提示需友好。

## 6. 待决问题（开工前需拍板）

1. 勾选框的默认状态（默认不勾？是否记忆上次选择）？
2. 勾选持久时，窗口挂载的会话：默认新会话，还是续最近会话？
3. 会话列表要不要做进 Nexus UI（还是先以命令行 `pi-durable ls` 过渡）？
4. 模型二期做不做（决定 durable 侧要不要补多 profile）。
