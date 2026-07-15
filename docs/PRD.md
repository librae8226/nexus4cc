# PRD — Nexus AI 终端面板

**版本**: v1.0.0  **状态**: Complete  **锚点**: `docs/NORTH-STAR.md`  **最后更新**: 2026-07-15

---

## Problem Statement

开发者需要一个统一入口，让 AI Agent 能在任意项目目录中持续运行，并能在 PC、手机、IM 等任意渠道随时介入——现有工具（ttyd、SSH）在移动端控制字符输入残缺，且缺乏针对 AI Agent 生命周期的管理界面和异步交互能力。

---

## Target Users

**用户即开发者本人**（单用户/个人服务器）
- 同时跑多个 Claude Code Agent，需要随时从任意设备查看进度、发送指令
- 外出时通过手机/Telegram 给 AI 下任务，回家后在 PC 上接续
- 不想保持 SSH 连接，关掉浏览器后 Agent 继续运行

---

## Core Features

### Must（v1 Complete）

| ID | Feature | 验收标准 |
|---|---|---|
| F-01 | WebSocket tmux 桥接 | 浏览器关闭后 tmux 和 Agent 继续运行；重新打开可接续 |
| F-02 | JWT 单密码认证 | 密码 bcrypt hash 存 env，Token 30天有效 |
| F-03 | xterm.js 终端渲染 | 256色/TrueColor/Unicode；scrollback 10000行 |
| F-04 | 移动端控制字符工具栏 | 可发送 Esc/Tab/Ctrl+C/方向键等；触摸不弹软键盘 |
| F-05 | 移动端滚动与缩放 | 单指滑动浏览历史；双指捏合调字号（8–32px） |
| F-06 | Session 管理 API | `POST/GET/DELETE /api/sessions`；tmux 新建/切换/关闭 window |
| F-07 | 工具栏服务端持久化 | 配置存 `data/toolbar-config.json`（volume），跨设备共享 |
| F-08 | PWA 支持 | manifest.json + Service Worker，可添加主屏幕 |
| F-12 | claude -c 会话续接 | 自动检测 `.claude-data/.claude`，`claude -c` 续接历史会话 |

### Should（v1 Complete）

> 对应北极星「轴三：极致 Agent 管理体验」

| ID | Feature | 验收标准 |
|---|---|---|
| F-09 | Tab Bar UI | 顶部实时显示所有 tmux window，点击切换，活跃 tab 高亮 |
| F-10 | 移动端底导航 | 底部 Tab 快速切换 window，支持新建；覆盖顶部 Tab Bar |
| F-11 | 独立 window PTY | `ensurePty(windowId)` Map；`/ws?window=N` 多设备不互扰 |
| F-15 | Agent 状态卡片 | 每个 window 显示最后输出摘要（是否在跑/是否等待输入） |

### Could（v1 Complete）

> 对应北极星「轴二：零摩擦上下文同步」——不限于浏览器终端的交互渠道

*(F-13/F-14/F-16/F-17 已移除 — 非交互派发、上下文附件、Telegram Bot、多渠道路由功能已从代码库中移除，不再需要。)*

### Done（原 Nice/v4 — 已提前完成）

> 对应北极星「轴一：零配置启动」——消灭一切不必要的决策步骤

| ID | Feature | 验收标准 |
|---|---|---|
| **F-19** | **项目-窗口两级结构** | **项目 = 目录，窗口 = 同目录标签**。新建项目时选目录；新窗口自动继承当前目录；消灭「每次新建都要选目录」的重复操作 |
| **F-20** | **统一会话管理界面** | **借鉴 Slack Workspace/Channel 模式**：项目列表（下部）+ 窗口列表（上部），新建按钮分区放置，视觉层次清晰 |

---

## Feature Detail: 项目-窗口两级结构（F-19）

**问题**：当前每次新建 window 都要选目录，而用户心智模型是「项目=目录，窗口=同目录下的多个标签」。

**解法**：利用 tmux session 环境变量存储项目目录，实现「新建项目选目录，新建窗口自动继承」。

```
POST /api/windows
  body: { rel_path?, shell_type?, profile? }

  场景 1 - 新项目（提供 rel_path）:
    → tmux set-environment NEXUS_CWD <dir>
    → tmux new-window -c "$dir"

  场景 2 - 新窗口（不提供 rel_path）:
    → cwd=$(tmux show-environment NEXUS_CWD | cut -d= -f2)
    → tmux new-window -c "$cwd"
```

**交互**：
- Sidebar 「+」按钮拆分为二级菜单：「📁 新项目」/「➕ 新窗口」
- 「新项目」→ 弹出 WorkspaceSelector 选目录
- 「新窗口」→ 直接创建，继承当前项目目录

**心智模型**：
- 项目 = 目录（首次需要指定）
- 窗口 = 同目录下的多个终端标签（自动继承目录）

---

## Feature Detail: 统一会话管理界面（F-20）

**核心映射**：直接使用 tmux 原生概念，前端映射更易理解
- **tmux session** → **Project**（工作目录，环境隔离）
- **tmux window** → **Channel**（终端标签，共享目录）

**设计灵感**：Slack 的 Workspace/Channel 两层导航结构
- Channel 列表（上部）：当前 Project 下的多个终端窗口
- Project 列表（下部）：不同的工作目录（每个对应一个 tmux session）

### 界面布局

```
┌─────────────────────────────┐
│  会话管理              [×]   │
├─────────────────────────────┤
│                             │
│  📂 nexus ~/work/nexus      │  ← 标题：当前 Project 名+路径
│  ─────────────────────────  │
│  #general        ●         │  ← Channel 列表（tmux windows）
│  #backend        ○         │
│  #test          ⏳         │
│                             │
│  [+ 新 Channel]            │  ← 在下方，靠近 Channel 列表
│                             │
│  ═════════════════════════  │  ← 粗分隔线
│                             │
│  📁 Projects               │
│  ● nexus           (3)     │  ← Project 列表（tmux sessions）
│  ○ my-app          (1)     │
│  ○ backend-api     (2)     │
│                             │
│  [+ 新 Project]            │  ← 在下方，靠近 Project 列表
│                             │
└─────────────────────────────┘
```

### 关键设计决策

| 概念 | 对应 | 说明 |
|------|------|------|
| Project | tmux session | 每个 session 独立环境变量，有自己的 NEXUS_CWD |
| Channel | tmux window | 同 session 内的多个窗口，共享工作目录 |
| 激活态 | active session/window | 高亮显示当前所在的 project 和 channel |

### 状态指示

```
Channel 列表项（带 # 前缀）：
  #general      ●    ← 绿色点 = 运行中
  #backend      ○    ← 灰色点 = 空闲
  #deploy      ⏳    ← 黄色点 = 等待输入
  #shell       💤    ← 灰色 = shell 状态

Project 列表项：
  ● nexus      (3)   ← 蓝色高亮 = 当前激活，(3)=3个channel
  ○ my-app     (1)   ← 未激活，有1个channel
  ○ backend-api (2)  ← 未激活，有2个channel
  ○ legacy          ← 无括号 = 该session没有窗口（异常）
```

### API 设计（简化版）

```
GET  /api/projects                → 列出所有 tmux sessions（Project 列表）
GET  /api/projects/:name/channels → 列出指定 session 的所有 windows（Channel 列表）

POST /api/projects                → 新建 Project
  body: { name, path, shell_type, profile? }
  → tmux new-session -d -s <name> -c <path>
  → tmux set-environment NEXUS_CWD <path>

POST /api/projects/:name/channels → 新建 Channel
  body: { shell_type, profile? }
  → 在当前 session 内 tmux new-window -c "$NEXUS_CWD"

POST /api/projects/:name/activate → 切换到指定 Project
  → 切换 active tmux session（attach-client 或设置 target）

POST /api/channels/:index/attach  → 切换到指定 Channel（已有接口）
DELETE /api/channels/:index       → 关闭 Channel（已有接口）
```

### 交互流程

**1. 新建 Project**
```
点击「+ 新 Project」
  → 弹出 WorkspaceSelector 选择目录
  → 用户输入 Project 名称（默认目录名）
  → POST /api/projects { name: "my-app", path: "/home/libra/work/my-app" }
  → tmux new-session -d -s my-app -c /home/libra/work/my-app
  → tmux set-environment -t my-app NEXUS_CWD /home/libra/work/my-app
  → 在该 session 创建第一个 window（自动命名为 #general 或目录名）
  → 自动切换到新 Project（Project 列表更新，Channel 列表加载）
```

**2. 新建 Channel**
```
点击「+ 新 Channel」
  → 检查当前是否有激活 Project
  → POST /api/projects/:name/channels { shell_type, profile }
  → 在当前 session 内创建新 window
  → 自动继承该 session 的 NEXUS_CWD
  → Channel 列表更新，自动切换到新 Channel
```

**3. 切换 Project**
```
点击 Project 列表中的某项
  → 设置该 session 为 active
  → Channel 列表区域刷新：显示该 Project 的所有 Channel
  → 自动切换到该 Project 的 active window（或第一个 window）
  → 终端 WebSocket 重连到新的 session:window
```

**4. 切换 Channel**
```
点击 Channel 列表中的某项
  → POST /api/channels/:index/attach
  → 同现有行为：切换到该 window
```

### Channel 命名规则

```
第一个 Channel（创建 Project 时）：
  - 默认：目录名（如 nexus）
  - 或：#general

后续 Channels：
  - 默认：目录名-序号（如 nexus-1, nexus-2）
  - 用户可重命名（重命名 tmux window）
```

### 空状态处理

**无任何 Project 时：**
```
Channel 列表区域：
  「没有活跃的 Project」

Project 列表区域：
  「暂无 Projects」
  [+ 创建第一个 Project]
```

**当前 Project 无 Channel（异常情况）：**
```
Channel 列表区域：
  "📂 nexus ~/work/nexus"
  「该 Project 没有 Channel」
  [+ 创建第一个 Channel]
```

### 向后兼容

- 现有 tmux session 直接显示为 Projects（name 作为 project name）
- 现有 windows 显示为 Channels
- 首次打开界面时，为当前 session 尝试读取 NEXUS_CWD
  - 如果未设置，提示用户「为当前 Project 设置工作目录」
  - 或自动设置为 WORKSPACE_ROOT

### 视觉设计

```css
/* Channel 列表区域（上部）*/
- 标题栏："📂 {project.name} {cwd路径}"（cwd 用灰色小字）
- Channel 项："#{name}" 前缀（Slack 风格）
- 状态点：跟在名字后面
- +按钮：在区域底部，样式与列表项对齐

/* Project 列表区域（下部）*/
- 标题栏："📁 Projects"
- 背景：var(--nexus-bg2) - 稍暗，与 Channel 区形成层次
- Project 项：简洁显示，名称 + 右侧 channel 计数
- +按钮：在区域底部

/* 分隔线 */
- Channel 区标题下：1px solid var(--nexus-border)
- 两区域之间：2px solid var(--nexus-border)
```

### 数据结构（前端状态）

```typescript
// 不再需要独立的 projects.json
// 直接从 tmux 读取

interface Project {
  name: string;           // tmux session name
  path: string;           // NEXUS_CWD (tmux show-environment)
  active: boolean;        // 是否是当前 active session
  channelCount: number;   // window 数量
}

interface Channel {
  index: number;          // tmux window index
  name: string;           // tmux window name
  active: boolean;        // 是否是该 session 的 active window
  status: 'running' | 'idle' | 'waiting' | 'shell'; // 状态推断
}
```

---

## Success Metrics

| Metric | Target |
|---|---|
| 移动端 Esc/Ctrl+C 发送成功率 | 100% |
| 浏览器重连后终端恢复时间 | < 2s |
| 工具栏配置跨设备同步 | 重连后自动加载 |
| PWA 添加主屏并可用 | iOS Safari / Android Chrome |

---

## Out of Scope

- 多用户/团队功能、注册系统、权限管理
- 替换 tmux（持久化/scrollback 继续由 tmux 负责）
- 通用 Web SSH 工具（不针对 claude CLI 工作流的功能不做）
- Session 数据库（JSON 文件 + tmux 实时读取）
- Docker socket 暴露给前端

---

## Known Limitations（v1）

| 问题 | 影响 | 解法 |
|---|---|---|
| 多客户端 resize 冲突 | 多设备同时连接时 PTY 尺寸以最后收到的为准 | 直接使用当前客户端尺寸 |
