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

## Highlights

| | |
|---|---|
| **AI on the go** | Your time is fragmented. Your AI shouldn't be. Command Claude Code from your phone — commuting, in a meeting, or away from your desk. |
| **Built for touch** | Not a desktop terminal shoehorned onto mobile. Swipe between windows, pinch-to-zoom, configurable toolbar — purpose-built for fingers. |
| **Full context, always** | Claude Code runs on your machine, in your tmux sessions — your full codebase, your history, your preferences. Not a cloud chat that forgets everything. |
| **Fire and forget** | Give the instruction, close your phone. Your agents keep running. Open later — everything's exactly where you left it. |

---

## Why Nexus 4 CC?

|                          | Anthropic Remote Control | Happy Coder | Omnara  | **nexus4cc** |
|--------------------------|:---:|:---:|:---:|:---:|
| Self-hosted              | ❌ | ❌ | ⚠️ | ✅ |
| No subscription needed   | ❌ ($100+/mo) | ✅ | ❌ ($9/mo) | ✅ |
| Data stays on your infra | ❌ | ❌ | ❌ | ✅ |
| Real terminal (xterm)    | ❌ | ❌ | ❌ | ✅ |
| Project & channel management | ❌ | ⚠️ | ⚠️ | ✅ |
| Fire & forget            | ⚠️ (10min timeout) | ✅ (via relay) | ✅ (via relay) | ✅ (pure tmux) |
| PWA / installable        | ❌ | ✅ (native app) | ✅ (native app) | ✅ |
| Open source              | ❌ | ⚠️ partial | ✅ | ✅ |

> **Project & channel management:** Organize work by directory-based projects, each with multiple channel-like sessions — switch between them instantly, like Slack channels for your terminal.

---

## Features

- 🔌 **WebSocket ↔ tmux bridge** — one PTY per window, real-time bidirectional I/O
- 📱 **Mobile-first terminal** — xterm.js, swipe navigation, pinch-to-zoom, configurable soft toolbar
- 🤖 **Task Panel** — launch Claude tasks, monitor via SSE streaming, async progress
- 📂 **File browser** — browse, edit, upload workspace files (sort by name / modified / size)
- 🗂️ **Project & channel management** — directory-based projects, each with channel-like sessions (like Slack channels for your terminal)
- 🔀 **Multi-session** — switch tmux sessions instantly
- 🎨 **PWA** — installable, dark / light themes
- ⚡ **Zero overhead** — direct WebSocket pipe, no SSH

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

## Install with Claude Code

If you're an AI assistant helping a user install Nexus, follow this path:

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
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design |
| [ROADMAP.md](docs/ROADMAP.md) | What's next |
| [📖 The story behind Nexus](docs/story.md) | Why this was built |

---

## Community

<p>
  <img src="https://github.com/user-attachments/assets/6960ca95-f26d-484b-aa66-56b5315e39d3" width="225" />
  <img src="https://github.com/user-attachments/assets/984ae5a2-7a88-45bf-b77a-20545c5c1bc1" width="250" />
</p>

---

## Contributing

PRs and issues welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for local dev setup, commit standards, and good first issue ideas.

---

## License

Dual-licensed: **[GPL v3](LICENSE.md)** for open-source use · **Commercial license** available for proprietary / SaaS use — contact [librae8226](https://github.com/librae8226) or [faywong](https://github.com/faywong)

---

*Built with Claude Code, for Claude Code.*
