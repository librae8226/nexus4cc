# Nexus4CC

### Your Claude Code, Everywhere.

[![Node](https://img.shields.io/badge/node-20+-brightgreen?style=flat-square)](https://nodejs.org/)
[![License: GPL v3](https://img.shields.io/badge/license-GPL%20v3%20%2F%20Commercial-blue?style=flat-square)](LICENSE.md)
[![GitHub stars](https://img.shields.io/github/stars/librae8226/nexus4cc?style=flat-square)](https://github.com/librae8226/nexus4cc/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](CONTRIBUTING.md)

[🇨🇳 中文](README_CN.md)

---

### Showcase

<p>
  <video src="https://github.com/user-attachments/assets/083495f7-d840-4733-9307-eaa815c2756f" width="45%" controls muted align="center">
    Your browser does not support the video tag.
  </video>
</p>

---

## What is Nexus4CC?

Nexus4CC turns any browser into a command center for **Claude Code** — and works with Codex, Gemini CLI, or any terminal-based AI agent. It bridges directly to tmux sessions running on your machine, so you can monitor, switch between, and command your agents from anywhere.

Phone, tablet, foldable, or desktop — one interface, every device. No cloud. No subscription. No SSH gymnastics. Just your terminal, everywhere.

---

## Features

| | |
|---|---|
| 🔌 **WebSocket ↔ tmux bridge** | One PTY per window. Real-time bidirectional I/O. Close your browser — your agents keep running. |
| 📱 **Any-screen terminal** | xterm.js with swipe navigation, pinch-to-zoom, and a configurable soft toolbar. Touch-friendly on mobile, full keyboard on desktop — one interface that adapts. |
| 📂 **Embedded file browser** | Browse, edit, and preview Markdown files in a resizable sidebar. Sort by name, date, or size. |
| 🗂️ **Project & channel management** | Directory-based projects with Slack-like channel sessions. Switch contexts instantly — like workspaces for your terminal. |
| 💾 **Session persistence** | tmux-resurrect keeps your sessions alive across reboots. Pick up exactly where you left off. |
| 🔀 **Multi-session** | Run multiple tmux sessions in parallel. Switch between them without leaving the browser. |
| 🎨 **PWA** | Installable on iOS and Android. Dark and light themes. Feels like a native app, works offline. |

---

## Why Nexus4CC?

|                          | Anthropic Remote Control | Happy Coder | Omnara  | **Nexus4CC** |
|--------------------------|:---:|:---:|:---:|:---:|
| Self-hosted              | ❌ | ❌ | ⚠️ | ✅ |
| No subscription needed   | ❌ | ✅ | ❌ | ✅ |
| Data stays on your infra | ❌ | ❌ | ❌ | ✅ |
| Real terminal (xterm)    | ❌ | ❌ | ❌ | ✅ |
| Project & channel management | ❌ | ⚠️ | ⚠️ | ✅ |
| Fire & forget            | ⚠️ | ✅ | ✅ | ✅ (pure tmux) |
| PWA / installable        | ❌ | ✅ | ✅ | ✅ |
| Open source              | ❌ | ⚠️ | ✅ | ✅ |

> **Project & channel management:** Organize work by directory-based projects, each with multiple channel-like sessions — switch between them instantly, like Slack channels for your terminal.

---

## Quick Start

```bash
git clone https://github.com/librae8226/nexus4cc.git && cd nexus4cc
cp .env.example .env          # set JWT_SECRET, ACC_PASSWORD_HASH, WORKSPACE_ROOT
npm install && cd frontend && npm install && npm run build && cd ..
npm start
# Open http://localhost:59000 on any device 🚀
```

> Full setup guide including Claude profile config, PM2, and mobile access: **[QUICKSTART.md →](docs/QUICKSTART.md)**

---

> 💡 **For human users:** follow the Quick Start above. The instructions below are for AI assistants helping with installation.

### For AI Assistants

If you're an AI assistant helping a user install Nexus:

1. Clone this repo and `cd` into it
2. Run `node scripts/setup.js` — handles deps, frontend build, PM2, and first tmux session
3. Verify: `pm2 status` shows `nexus` online → open `http://localhost:59000`

Prerequisites: Node.js 20+, tmux. PM2 is installed automatically if missing.  
Default login password: `nexus123` (user can change it in `.env` after setup).

---

## Deployment

Expose securely without port forwarding via [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or [Tailscale](https://tailscale.com/).

---

## Requirements

| Dependency | Version | Note |
|---|---|---|
| Node.js | 20+ | |
| tmux | any recent | |
| PM2 | any recent | auto-installed by `setup.js` |
| OS | Linux / WSL2 | |

---

## Security

Nexus is a **single-user, self-hosted tool** — not a multi-tenant platform.

- 🔒 bcrypt (12 rounds) password hash + JWT (30d)
- ⚠️ WebSocket token passed via query string — enable TLS in production
- 🛡️ Run behind firewall, VPN, or tunnel — do not expose directly to the internet

---

## Documentation

| Doc | |
|---|---|
| [QUICKSTART.md](docs/QUICKSTART.md) | Step-by-step setup guide |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design & API reference |
| [PRD.md](docs/PRD.md) | Feature specifications |
| [ROADMAP.md](docs/ROADMAP.md) | What's next |
| [📖 The story behind Nexus](docs/story.md) | Why this was built |

---

## Community

<p>
  <img src="https://github.com/user-attachments/assets/6960ca95-f26d-484b-aa66-56b5315e39d3" width="225" />
</p>

---

## Author

Nexus4CC was built by [Librae](https://github.com/librae8226) — software engineer, entrepreneur, and early-stage VC investor.

The best ideas never come at your desk. Nexus4CC was born from a real need: commanding AI agents on the go — from airports, taxis, and between meetings. Now it's open source, and it's yours.

---

## Contributing

PRs and issues welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for local dev setup, commit standards, and good first issue ideas.

---

## License

Dual-licensed: **[GPL v3](LICENSE.md)** for open-source use · **Commercial license** available for proprietary / SaaS use — contact [librae8226](https://github.com/librae8226) or [faywong](https://github.com/faywong)

---

*Built for **Claude Code** first. Also works with any AI agent that runs in a terminal.*
