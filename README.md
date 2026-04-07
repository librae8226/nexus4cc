# ⚡️Nexus4CC

### Your Claude Code, Everywhere.

**跨设备 AI 终端桥接 · 专为 Claude Code 打造 · 移动端优先**

<p>
  <img src="https://cdn.gooo.ai/web-images/d61f1cb1b9434e10af05e6d6059fab3cbaafd20ac16cc6d35b6a6502fe8e1eb2" alt="Node.js" />
  <img src="https://cdn.gooo.ai/web-images/20f0c4badbfb4abe840d2fe64cc77c73c5dc796d8f0a6cdc56823f95edd72294" alt="React" />
  <img src="https://cdn.gooo.ai/web-images/0f4a900586ad7dffbe8cc55b99351cdb657c326f85e349440750be2ce3a7111e" alt="License" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
</p>

**English** | [中文](#%E4%B8%AD%E6%96%87)

---

### Showcase

<p>
  <video src="https://github.com/user-attachments/assets/083495f7-d840-4733-9307-eaa815c2756f" width="45%" controls muted align="center">
    Your browser does not support the video tag.
  </video>
</p>

---

### Join Discussion

<p>
  <img src="https://github.com/user-attachments/assets/6960ca95-f26d-484b-aa66-56b5315e39d3" width="225" />
  <img src="https://github.com/user-attachments/assets/984ae5a2-7a88-45bf-b77a-20545c5c1bc1" width="250" />
</p>

---

## The Story Behind Nexus

I've worn three hats in my career — software engineer, startup founder, and early-stage tech VC. Each role demanded a different rhythm, but they all shared one constant: **the best ideas never hit when you're at your desk.**

Reviewing a founder's codebase during a layover. Debugging a production issue from a taxi. Researching competitive landscape while commuting. Kicking off a Claude Code agent to scaffold a prototype while waiting for a meeting to start — then organizing todos after the meeting. On my phone.

The problem was always the same: **Claude Code lives in the terminal, and the terminal lives on your laptop.** The moment you step away, you lose your superpower.

So I built Nexus — a WebSocket bridge that turns any browser into a first-class Claude Code interface. It started as a weekend hack: a tmux session I could reach from my iPhone. Then I added a task panel for long-running Claude agents. Then a file browser so I could review changes on the go.

Before I knew it, Nexus had become the **super entry point for my AI workflow** — three roles, countless scenarios, converging here.

Now it's yours.

---

## Why Nexus4CC?

Claude Code is arguably the most powerful AI coding agent available today. But its terminal-native design creates a hard constraint: **you need a shell, and you need it now.**

Nexus removes that constraint.

| Pain Point | Nexus Solution |
| --- | --- |
| Claude Code is locked to your laptop terminal | Access any tmux session from any device via WebSocket |
| Mobile terminals are unusable | Purpose-built touch UX — swipe between windows, pinch-to-zoom, configurable soft toolbar |
| Long-running agents need babysitting | Task Panel with SSE streaming — fire and forget, check back anytime |
| Constant switching between files and terminal | Integrated file browser with edit, upload, and sort capabilities |

**Nexus is not a general-purpose terminal emulator.** It is a carefully crafted bridge around one core workflow: **running Claude Code from anywhere, especially your phone.**

---

## Features

- 🔌 **WebSocket ↔ tmux Bridge** — One PTY per tmux window, real-time bidirectional I/O

- 📱 **Mobile-First Web Terminal** — xterm.js + swipe navigation + pinch-to-zoom + configurable soft toolbar

- 🤖 **Task Panel** — Launch Claude tasks via SSE streaming, monitor progress asynchronously

- 📂 **File Browser** — Browse, edit, upload workspace files (sort by name / modified / size)

- 🔀 **Multi-Session** — Switch between tmux sessions instantly

- 🎨 **PWA** — Installable, dark/light themes

- ⚡ **Zero Latency Feel** — Direct WebSocket pipe, no SSH overhead

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/user/nexus4cc.git && cd nexus4cc

# 2. Configure
cp .env.example .env
# Edit .env — set three things:
#   JWT_SECRET=$$(openssl rand -hex 32)
#   ACC_PASSWORD_HASH=$$(node -e "console.log(require('bcrypt').hashSync('your-password', 12))")
#   WORKSPACE_ROOT=/your/workspace

# 3. Create a Claude Profile (required!)
mkdir -p data/configs
cat > data/configs/anthropic.json << 'EOF'
{
  "label": "Anthropic Claude",
  "BASE_URL": "",
  "AUTH_TOKEN": "",
  "API_KEY": "",
  "DEFAULT_MODEL": "claude-sonnet-4-6",
  "THINK_MODEL": "claude-opus-4-6",
  "LONG_CONTEXT_MODEL": "claude-opus-4-6",
  "DEFAULT_HAIKU_MODEL": "claude-haiku-4-5-20251001",
  "API_TIMEOUT_MS": "3000000"
}
EOF

# 4. Install & Build
npm install
cd frontend && npm install && npm run build && cd ..

# 5. Launch
npm start
# For production with PM2: pm2 start ecosystem.config.cjs

# 6. Open http://localhost:59000 on any device 🚀
```

> **Tip:** Expose via Cloudflare Tunnel or Tailscale for secure remote access without port forwarding.

📖 **[Complete Quick Start Guide →](docs/QUICKSTART.md)** (includes profile setup, troubleshooting, and mobile access)

---

## Requirements

| Dependency | Version |
| --- | --- |
| Node.js | 20+ |
| tmux | Any recent version |
| OS | Linux / WSL2 (Windows via WSL2) |

---

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) · [NORTH-STAR.md](NORTH-STAR.md)

---

## Security Notes

Nexus is designed as a **single-user, self-hosted tool**. It is not a multi-tenant platform.

- 🔒 **Auth** — bcrypt (12 rounds) password hashing + JWT

- ⚠️ **WS Token** — Passed via query string (WebSocket limitation) — enable TLS in production

- 📁 **File Access** — Full read/write access to `WORKSPACE_ROOT` — sandbox as needed

- 🛡️ **Deployment** — Run behind firewall, VPN, or tunnel (Tailscale / Cloudflare Tunnel recommended)

- 📝 **History** — Commit `b3905e5` contains a rotated test secret (historical only, no risk)

---

## Development

```bash
# Backend hot reload
npm run dev

# Frontend dev server (Vite)
cd frontend && npm run dev
```

---

## Documentation

| Doc | Description |
| --- | --- |
| [QUICKSTART.md](docs/QUICKSTART.md) | **Start here** — step-by-step setup guide |
| [NORTH-STAR.md](NORTH-STAR.md) | Core principles & constraints |
| [PRD.md](PRD.md) | Feature specifications |
| [ROADMAP.md](ROADMAP.md) | What's next |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design |

---

## Contributing

PRs and issues welcome! Whether it's a bug fix, new feature, or docs improvement — every contribution matters.

---

## License

MIT — See [LICENSE.md](LICENSE.md)

---

*Built with 🧠 and Claude Code, for Claude Code.*

---

---

# 中文

### 你的 Claude Code，随身携带。

**跨设备 AI 终端桥接 · 专为 Claude Code 打造 · 移动端优先**

---

## Nexus 的故事

我的职业生涯经历了三个身份——软件工程师、创业者、早期科技 VC 投资人。每个角色的节奏截然不同，但有一件事始终不变：**最好的想法从来不会在办公桌前出现。**

转机途中审阅代码或者紧急修复线上 Bug，出租车上调研细分行业的竞争格局，等会议开始前，在手机上让 Claude Code 帮我搭建一个原型，会议后整理 todo 设定待办——这些都是我的日常。

问题始终是同一个：**Claude Code 活在终端里，而终端活在你的笔记本上。** 一旦离开电脑，你就失去了超能力。

于是我造了 Nexus——一座 WebSocket 桥梁，让任何浏览器都成为 Claude Code 的一等公民界面。它最初只是一个周末 Hack：一个我能从 iPhone 上访问的 tmux 会话。后来加了任务面板，用来跑长时间的 Claude Agent。再后来加了文件浏览器，方便在路上 Review 代码变更。

不知不觉间，Nexus 变成了我 **AI 工作流的超级入口**——三种身份、无数场景，汇聚于此。

现在，它也是你的了。

---

## 为什么选 Nexus4CC?

Claude Code 可能是当下最强大的 AI 编程 Agent。但它的终端原生设计带来了一个硬约束：**你需要一个 Shell，而且是现在就要。**

Nexus 消除了这个约束。

| 痛点 | Nexus 方案 |
| --- | --- |
| Claude Code 被锁在笔记本终端里 | 通过 WebSocket 从任何设备访问 tmux 会话 |
| 手机上的终端根本没法用 | 专为触控打造的 UX——滑动切换窗口、双指缩放、可配置软键盘工具栏 |
| 长时间运行的 Agent 需要盯着 | 任务面板 + SSE 流式输出——发射后不管，随时回来查看 |
| 终端和文件之间反复切换 | 集成文件浏览器，支持编辑、上传、排序 |

**Nexus 不是通用终端模拟器。** 它是围绕一个核心工作流精心打造的桥梁：**从任何地方运行 Claude Code，尤其是你的手机。**

---

## 功能

- 🔌 **WebSocket ↔ tmux 桥接** — 每个 tmux window 一个 PTY，实时双向 I/O

- 📱 **移动端优先 Web 终端** — xterm.js + 滑动导航 + 双指缩放 + 可配置软键盘工具栏

- 🤖 **任务面板** — SSE 流式输出 Claude 任务，异步监控进度

- 📂 **文件浏览器** — 浏览、编辑、上传工作区文件（按名称/修改时间/大小排序）

- 🔀 **多会话管理** — 秒切 tmux session

- 🎨 **PWA** — 可安装、深色/浅色主题

- ⚡ **零延迟体感** — WebSocket 直连，无 SSH 开销

---

## 快速启动

```bash
# 1. 克隆
git clone https://github.com/user/nexus4cc.git && cd nexus4cc

# 2. 配置
cp .env.example .env
# 编辑 .env,设置三项:
#   JWT_SECRET=$$(openssl rand -hex 32)
#   ACC_PASSWORD_HASH=$$(node -e "console.log(require('bcrypt').hashSync('你的密码', 12))")
#   WORKSPACE_ROOT=/你的/工作目录

# 3. 创建 Claude Profile（重要！）
mkdir -p data/configs
cat > data/configs/anthropic.json << 'EOF'
{
  "label": "Anthropic Claude",
  "BASE_URL": "",
  "AUTH_TOKEN": "",
  "API_KEY": "",
  "DEFAULT_MODEL": "claude-sonnet-4-6",
  "THINK_MODEL": "claude-opus-4-6",
  "LONG_CONTEXT_MODEL": "claude-opus-4-6",
  "DEFAULT_HAIKU_MODEL": "claude-haiku-4-5-20251001",
  "API_TIMEOUT_MS": "3000000"
}
EOF

# 4. 安装构建
npm install
cd frontend && npm install && npm run build && cd ..

# 5. 启动
npm start
# 生产环境推荐 PM2:pm2 start ecosystem.config.cjs

# 6. 在任意设备打开 http://localhost:59000 🚀
```

> **小贴士：** 通过 Cloudflare Tunnel 或 Tailscale 暴露服务，无需端口转发即可安全远程访问。

📖 **[完整快速开始指南 →](docs/QUICKSTART.md)**（含 Profile 配置、故障排查、移动端访问）

---

## 环境要求

| 依赖 | 版本 |
| --- | --- |
| Node.js | 20+ |
| tmux | 任意近期版本 |
| 操作系统 | Linux / WSL2(Windows 通过 WSL2) |

---

## 架构

参见 [ARCHITECTURE.md](ARCHITECTURE.md) · [NORTH-STAR.md](NORTH-STAR.md)

---

## 安全说明

Nexus 设计为**单用户自托管工具**，不是多租户平台。

- 🔒 **认证** — bcrypt(12 轮）密码哈希 + JWT

- ⚠️ **WS Token** — 通过 query string 传递（WebSocket 限制）— 生产环境请启用 TLS

- 📁 **文件访问** — 对 `WORKSPACE_ROOT` 拥有完整读写权限 — 按需沙箱隔离

- 🛡️ **部署建议** — 在防火墙、VPN 或隧道后运行（推荐 Tailscale / Cloudflare Tunnel）

- 📝 **历史备注** — Commit `b3905e5` 包含已轮换的测试密钥（仅历史记录，无风险）

---

## 开发

```bash
# 后端热重载
npm run dev

# 前端开发服务器(Vite)
cd frontend && npm run dev
```

---

## 文档

| 文档 | 说明 |
| --- | --- |
| [QUICKSTART.md](docs/QUICKSTART.md) | **新手从这里开始** — 手把手配置指南 |
| [NORTH-STAR.md](NORTH-STAR.md) | 核心原则与约束 |
| [PRD.md](PRD.md) | 功能规格说明 |
| [ROADMAP.md](ROADMAP.md) | 未来规划 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 系统架构设计 |

---

## 贡献

欢迎 PR 和 Issue！无论是修 Bug、加功能还是改文档——每一份贡献都有意义。

---

## 许可

MIT — 见 [LICENSE.md](LICENSE.md)

---

*用 🧠 和 Claude Code 构建，为 Claude Code 而生。*
