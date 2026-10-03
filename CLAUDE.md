# CLAUDE.md — Nexus Development Standards

Project: **Nexus** — WebSocket tmux 桥接，AI 终端移动端面板
Anchor: `docs/NORTH-STAR.md` — 修改任何文档前先对照锚点三原则

---

## Tech Stack

| Layer | Tech |
|---|---|
| Backend | Node.js (ESM) + Express + ws + node-pty |
| Frontend | React 18 + TypeScript + xterm.js + Vite |
| Auth | JWT (30d) + bcrypt password hash |
| Runtime | 宿主机（WSL2）直接运行，Node.js + PM2 管理 |
| Config | `.env` → `server.js` 顶部解构，无 dotenv 依赖 |
| Persist | `./data/`（toolbar config、session configs） |

## Architecture Constraints

- **tmux server 不属于 Nexus**：由 `nexus-tmux.service` 管理（环境、socket 目录、恢复触发都在那里）。
  Nexus 里任何地方都不得 ad-hoc 起 server（`new-session`），要经 `tmuxServerUp()` 守卫 —— 否则会造出
  不受 systemd 管的野生 server。隔离/演练必须 `env -u TMUX -u TMUX_PANE TMUX_TMPDIR=<dir>`
  （tmux 不认 `TMPDIR`），拆服务器只用显式 `tmux -S <path> kill-server`。

- **多 PTY 架构**（F-11）：每个 `tmux session:window` 独立 PTY 实例，`ptyMap` 管理
- **前端 dist 由 Vite 构建**，server.js 静态伺服 `frontend/dist/` + `public/`
- **no database**：会话状态从 tmux 实时读取，持久化只用 JSON 文件
- `WORKSPACE_ROOT` 指向宿主机工作区根目录，server.js 直接访问

## Key Files

```
server.js                  # 唯一后端入口：Express + WS + PTY
walkie.js                  # 对讲机模式后端（F-24）：频道清单/直达发送/精炼/回复追踪
deploy/systemd/
  nexus-tmux.service       # tmux server 的 systemd 服务（开机起 server + 触发会话恢复）
scripts/
  tmux-server-supervise.sh # unit 的 ExecStart：前台守 server，死了交给 Restart=always
  tmux-server-ready.sh     # unit 的 ExecStartPost：等就绪 + 保证 main + 后台触发恢复
  nexus-restore-tmux.sh    # 把快照里缺的 session/channel 补回来（幂等、只增不改）
  nexus-rescue.sh          # break-glass 救援（零 root：补目录 → 起 server → 恢复 → 诊断）
  tmux-snapshot.sh         # 独立于客户端的快照触发器（nexus-tmux-snapshot.timer 每 5 分钟调）
  nexus-watchdog.sh        # 页面看门狗（nexus-watchdog.timer 每分钟：探活失败 3 次→重启；app 丢了→从 ecosystem 拉起）
capacitor.config.json      # Android 壳配置（webDir=frontend/dist）
android/                   # Capacitor Android 工程（F-23）
  Dockerfile               #   构建环境（Android SDK 在容器里，宿主机零污染）
  build-apk.sh             #   构建入口：cap sync + gradlew，产物在 app/build/outputs/apk/
data/                      # 持久化数据（toolbar、configs）
public/
  sw.js                    # Service Worker（cache-first 静态资源）
  icon.svg                 # PWA 图标
  manifest.json            # PWA manifest
frontend/src/
  App.tsx                  # 路由：登录页 / 终端页
  Terminal.tsx             # xterm.js + WebSocket + 触摸处理
  Toolbar.tsx              # 可配置工具栏（固定行 + 展开区）
  TabBar.tsx               # tmux window 标签（< 768px 顶部导航）
  SessionManager.tsx       # 旧版 session 面板（lazy, legacy）
  SessionManagerV2.tsx     # Project-Channel 双层会话管理（lazy）
  WorkspaceSelector.tsx    # 目录选择器（lazy）
  WorkspaceBrowser.tsx     # 文件浏览器（嵌入式侧栏 + 全屏 overlay）
  FilePanel.tsx            # 文件查看/编辑/Markdown 预览（lazy）
  GeneralSettings.tsx      # 通用设置面板（lazy）
  NewWindowDialog.tsx      # 新建窗口对话框（lazy）
  SessionFAB.tsx           # 移动端浮动操作按钮
  GhostShield.tsx          # 覆盖层守卫（防止意外 keyboard 弹出）
  toolbarDefaults.ts       # 按键定义与出厂配置
  walkie/                  # 对讲机模式（F-24）：双旋钮 + 按住说话，实验特性
    WalkieApp.tsx          #   根状态机；ChannelDial.tsx 双旋钮（拟物 + 咔嗒声 + 震动）
    audio.ts               #   PCM 采集 + 静音切段 + WAV 编码（边说边出字的地基）
    speech.ts              #   逐段送本机 ASR；feedback.ts 咔嗒声与震动
    api.ts / tts.ts / mode.ts / walkie.css
  windowStatus.ts          # 窗口状态检测（Terminal + TabBar 共享）
  icons.tsx                # 图标组件
  mobileInput.ts           # 移动端键盘映射
  useOverlayGuard.ts       # Overlay 点击防护 hook
  i18n/                    # 国际化入口
  locales/                 # 翻译文件（en, zh-CN）
docs/
  NORTH-STAR.md            # 锚点文件（核心问题/用户/Out-of-Scope）
  ANDROID-APP.md           # Android 客户端需求 + 技术方案（F-23）
  PRD.md                   # 功能规格
  ROADMAP.md               # 迭代路线图
  ARCHITECTURE.md          # 架构现状
  QUICKSTART.md            # 快速开始指南
  SESSION-PERSISTENCE.md   # 会话持久化方案
  WALKIE.md                # 对讲机模式（F-24）：设计取舍 + 两个 APK 的构建方式
  HISTORY_MODE_REDESIGN.md # 历史模式重设计（设计阶段）
  story.md                 # 项目故事/背景
  pm2-setup.md             # PM2 部署指南
```

## Agent Workflow Rules

- **用 `/plan`**：涉及多文件改动、架构变更、新 API endpoint、PTY 行为变更
- **用 `/tdd`**：新增工具栏按键逻辑、认证流程、API endpoint
- **直接做**：单文件 UI 调整、样式修复、文档更新

## Definition of Done

- Implementation matches requirements — no speculative features
- `docs/NORTH-STAR.md` 三原则未被违反（对照确认）
- Manual verification：打开浏览器验证受影响的用户流
- Commit follows standard below

## Version Management

**Source of truth: git tag**（`git describe --tags --abbrev=0`）

每次发布新版本时必须同步更新以下文件，否则版本显示会不一致：

| 文件 | 字段 |
|---|---|
| `package.json` | `"version"` |
| `frontend/package.json` | `"version"` |

**Android 不在此列** —— 它是派生消费方，不是第四个手工维护点。
`android/app/build.gradle` 从仓库根的 `package.json` 读版本并派生
`versionName`/`versionCode`（`4.8.6` → `40806`），所以上面这套流程产出的 APK
版本自动是对的。改 `package.json` 版本后 APK 无需任何额外操作。

发布流程：
```bash
# 1. 确认工作区干净
git status

# 2. 更新两个 package.json 的 version 字段

# 3. 提交
git add package.json frontend/package.json
git commit -m "chore: bump version to X.Y.Z"

# 4. 打 tag 并推送
git tag vX.Y.Z
git push && git push --tags
```

**不要**在 i18n 文件或代码里硬编码版本号 — Settings > About 通过 `/api/version`（读 git tag）动态显示，无需手动维护。

## Git Commit Standard

```
type(scope): imperative subject ≤ 72 chars

Body (optional, any language): explain why, not what.
Bug fixes: explain root cause.

Co-Authored-By: Claude <noreply@anthropic.com>
```

Types: `feat` `fix` `docs` `refactor` `test` `chore` `style`

Rules: English subject, imperative mood, no trailing period, blank line before body, **Co-Authored-By trailer required**.

## Code Standards

### General
- Implement only what the current task requires
- No speculative features, no opportunistic cleanup
- One logical change per commit

### TypeScript / React
- Strict mode; no `any`
- State and side effects via hooks only
- Single responsibility per component

### Security
- Secrets via env vars only — never hardcoded
- `.env` must not be committed (verify `.gitignore`)
- CORS: production must list explicit origins, no wildcards

## Agentic Behavior

- **Minimal footprint**: use only permissions needed
- **Prefer reversible actions**: confirm before destructive ops
- **Pause and ask** when scope exceeds request, destructive side-effect discovered, or intent is unclear
- **No opportunistic work**: no unrequested refactoring

## Documentation Map

| Change type | Update |
|---|---|
| New feature / interface | `README.md` + `docs/PRD.md` |
| Roadmap / scope change | `docs/ROADMAP.md` |
| Architecture change | `docs/ARCHITECTURE.md` |
| Process / convention | `CLAUDE.md` (this file) + `docs/MAINTENANCE.md` |
| Env var added | `.env.example` + commit body |
| Bug fix | commit body (root cause) |
| Session/persistence change | `docs/SESSION-PERSISTENCE.md` |
