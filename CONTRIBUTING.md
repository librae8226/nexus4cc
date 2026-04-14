# Contributing to Nexus4CC

Thanks for taking the time to contribute. Whether it's a bug fix, new feature, or docs improvement — every contribution matters.

---

## Local Development

**Prerequisites:** Node.js 20+, tmux, Linux / WSL2

```bash
# Clone
git clone https://github.com/librae8226/nexus4cc.git && cd nexus4cc

# Install dependencies
npm install
cd frontend && npm install && cd ..

# Start backend with hot reload
npm run dev

# Start frontend dev server (separate terminal)
cd frontend && npm run dev
# Frontend at http://localhost:5173, proxies API to backend
```

---

## Before You Submit

1. **Read [NORTH-STAR.md](NORTH-STAR.md)** — three principles that must not be violated
2. **Manual test in browser** — open the affected user flow and verify it works
3. **One logical change per PR** — keep scope tight

---

## Commit Message Standard

```
type(scope): imperative subject ≤ 72 chars

Body (optional): explain why, not what.
Bug fixes: explain root cause.

Co-Authored-By: Claude <noreply@anthropic.com>
```

Types: `feat` `fix` `docs` `refactor` `test` `chore` `style`

Examples:
```
feat(toolbar): add Ctrl+L keybinding to toolbar defaults
fix(terminal): sync wsSessionKey on restore
docs(readme): update Quick Start for WSL2 users
```

---

## Good First Issues

If you're new to the codebase, these are good places to start:

- **New toolbar buttons** — add keybindings in `frontend/src/toolbarDefaults.ts`
- **Docs improvements** — QUICKSTART.md, ARCHITECTURE.md always welcome
- **i18n** — UI strings in `frontend/src/`
- **Bug reports with reproduction steps** — always valuable

---

## Questions?

Open an issue or reach out via WeChat (librae8226).
