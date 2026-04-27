# TheClaudenental

> Your Claude Code dashboard — your personal cockpit for AI-assisted development.

A web dashboard that runs alongside [Claude Code](https://claude.com/claude-code), giving you a structured view of your sessions, costs, ratings, and a Trello-style TODO board for managing your work.

**Status**: Active alpha. Self-hosted only. Not yet a public release.

---

## What it does

- **Sessions panel** — see every Claude Code session with cost / status / activity heat
- **Chat panel** — full conversation view with message search, thinking blocks, ratings
- **TODO board** — 7-column Kanban (想到了 / 討論中 / 實作中 / 驗證中 / 完成 / 擱置 / 倉庫) with drag-to-trigger Chat workflow
- **心腹 (Workflows)** — pre-built prompt templates for common tasks (knowledge absorption, debugging, planning, etc.)
- **Bounty system** — gamified cost tracking (John Wick Continental theme)
- **Ratings** — rate Claude's responses to inform your own preferences over time
- **Cross-device sync** — runs on localhost, accessible from your phone via Tailscale

Built around the **progressive disclosure** principle from Anthropic's Agent Skills:
- Cards = interface layer (metadata + status)
- Topic markdowns = content layer
- knowledge/ + memory/ = permanent layer

---

## Architecture

```
Claude Code (hooks)
       │
       ├──► Claudia (port 48901)             — desktop monitor app (optional)
       │
       └──► TheClaudenental Server (3001)    — Fastify + WebSocket
                    │
                    ├── /hook                — receives Claude Code hook events
                    ├── /api/*               — REST endpoints
                    └── /ws                  — WebSocket broadcasts
                                │
                         React Frontend (4444) — Vite dev server
                                │
                         Browser (desktop / mobile via Tailscale)
```

**Tech**: Node.js v24+ · Fastify · WebSocket · React 18 · Vite · Tailwind · dnd-kit

---

## For Developers (協作者)

Want to help polish the codebase?

👉 **[SETUP_FOR_DEV.md](SETUP_FOR_DEV.md)** — full setup guide (Anthropic API key, Node, Claude Code, clone, run)

👉 **[CONTRIBUTING.md](CONTRIBUTING.md)** — branch / PR / commit conventions

---

## Quick Start (you have all prerequisites)

```bash
git clone https://github.com/markbolobo/TheClaudenental.git
cd TheClaudenental

# Server
cd server && npm install && node index.js   # listens on :3001

# Client (new terminal)
cd client && npm install && npm run dev      # serves :4444

# Open http://localhost:4444
```

---

## Status & Roadmap

- ✅ P1 — TODO board with drag-to-trigger Chat
- ✅ P2 — Multi-user (owner + collaborators) + card sharing
- ✅ P3 — Card kind (task/knowledge) + sediment to md
- 🚧 Alpha verification — finding rough edges before opening up
- 🔜 Public release — TBD when stable

---

## License

All Rights Reserved (for now). Considering open-source license once alpha stabilizes.

If you want to use this for your own work, please open an issue to discuss.
