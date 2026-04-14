# GitHub Facade Design — Nexus4CC

**Date:** 2026-04-08  
**Status:** Approved  
**Scope:** GitHub repository presentation only (website/landing page is a separate initiative)

---

## Goals

Make the Nexus4CC GitHub page compelling for target users at first glance:
- Engineers, founders, PMs, analysts who work on the move
- Both international (English) and Chinese tech community

Brand tone: clean, confident, quietly impressive. No hype, no clutter.

## Constraints

- Keep tagline: **"Your Claude Code, Everywhere."**
- Keep demo video as-is (no added description text)
- Keep core product philosophy (NORTH-STAR.md unchanged)
- Keep contact info (微信: librae8226)
- Keep license info (now dual: GPL v3 / Commercial)

---

## Language Strategy

**English-first with separate Chinese README.**

- `README.md` — English (primary, what GitHub shows by default)
- `README_CN.md` — Full Chinese version, linked via badge at top of README

Rationale: Standard for international open-source projects. Chinese users are comfortable on GitHub; a badge is sufficient. Current bilingual-in-one approach dilutes first impression with page length.

---

## README.md Structure (English)

### 1. Header

```
# Nexus4CC
### Your Claude Code, Everywhere.

[Node 20+] [GPL v3 / Commercial] [⭐ Stars] [🇨🇳 中文]
```

Badges: flat-style (shields.io). Stars badge uses dynamic count.

### 2. Demo

Existing video embed — unchanged.

### 3. Why Nexus?

Four value propositions, table format. Occam's razor applied — no repetition:

| | |
|---|---|
| **AI on the go** | Your time is fragmented. Your AI shouldn't be. Command Claude Code from your phone — commuting, in a meeting, or away from your desk. |
| **Built for touch** | Not a desktop terminal shoehorned onto mobile. Swipe between windows, pinch-to-zoom, configurable toolbar — purpose-built for fingers. |
| **Full context, always** | Claude Code runs on your machine, in your tmux sessions — your full codebase, your history, your preferences. Not a cloud chat that forgets everything. |
| **Fire and forget** | Give the instruction, close your phone. Your agents keep running. Open later — everything's exactly where you left it. |

### 4. Features

Compact 2-column list. No paragraph descriptions, just labels:

- 🔌 WebSocket ↔ tmux bridge (one PTY per window)
- 📱 Mobile-first web terminal (xterm.js)
- 🤖 Task Panel — SSE streaming, async progress
- 📂 File browser — edit, upload, sort
- 🔀 Multi-session switching
- 🎨 PWA — installable, dark/light themes
- ⚡ Zero-overhead direct pipe

### 5. Quick Start

Minimal version — 5 commands only. Heavy config (JSON profile setup) moved to QUICKSTART.md link:

```bash
git clone https://github.com/librae8226/nexus4cc.git && cd nexus4cc
cp .env.example .env          # set JWT_SECRET, ACC_PASSWORD_HASH, WORKSPACE_ROOT
npm install && cd frontend && npm install && npm run build && cd ..
npm start
# Open http://localhost:59000 on any device
```

> Full setup guide including Claude profile config, PM2, and mobile access: **[QUICKSTART.md →](docs/QUICKSTART.md)**

### 6. Deployment Note

One sentence: recommend Cloudflare Tunnel or Tailscale for remote access.

### 7. Security

Three bullet points only, link to details in README section.

### 8. Requirements

Minimal table: Node 20+, tmux, Linux/WSL2.

### 9. Documentation

| Doc | Description |
|---|---|
| [QUICKSTART.md](docs/QUICKSTART.md) | Step-by-step setup |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design |
| [ROADMAP.md](docs/ROADMAP.md) | What's next |
| [📖 The story behind Nexus →](docs/story.md) | Why this was built |

### 10. Contributing

3 lines: "PRs and issues welcome. See CONTRIBUTING.md."

### 11. Footer

```
Dual-licensed: GPL v3 / Commercial · Built with Claude Code, for Claude Code.
```

---

## README_CN.md Structure (Chinese)

Mirrors English structure. Additions:
- "Why Nexus" values expressed more conversationally in Chinese
- Author background section (三个身份: 工程师 / 创业者 / 投资人) — Chinese audience responds to this

---

## GitHub Repository Settings (Manual)

**Description:**
```
Give Claude Code commands from your phone. Your AI agents keep running while you're away — resume instantly from any device.
```
No jargon (no "WebSocket", "tmux", "PTY"). Understandable by anyone who knows what Claude Code is.

**Topics:**
```
claude-code  claude  ai-tools  terminal  tmux  pwa  mobile  self-hosted  websocket  xterm
```

**Website:** Set after landing page is built (next initiative).

---

## .github/ Directory

### CONTRIBUTING.md
- Local dev setup (backend hot reload + frontend Vite dev server)
- Commit message standard (matches CLAUDE.md)
- PR guidelines
- Good first issue ideas: new toolbar buttons, i18n, docs improvements

### Issue Templates

**bug_report.md** fields:
- Describe the bug
- Steps to reproduce
- Expected behavior
- Environment (OS, Node version, browser)

**feature_request.md** fields:
- Use case / scenario
- Proposed solution
- Alternatives considered

### pull_request_template.md

Checklist:
- [ ] Tested manually in browser
- [ ] No speculative features added
- [ ] NORTH-STAR.md principles not violated
- [ ] Commit follows standard (type(scope): subject)

---

## docs/ Adjustments

- Add `docs/story.md` to the Documentation table in README as "📖 The story behind Nexus →"
- No other structural changes to docs/

---

## Social Preview (Deferred)

Design a 1280×640 SVG: dark background, project name, tagline, stylized mobile terminal outline. To be placed in repo settings → Social preview. Deferred to follow-up session.

---

## Out of Scope

- Landing page / website (separate initiative)
- GitHub Actions / CI changes
- Code changes of any kind
- i18n system changes
