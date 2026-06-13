# FoxTrot — Randall's Nightly Tournaments

> Backend API + website for **Randall's Nightly Tournaments**: free, nightly,
> regional Super Smash Bros. Melee brackets. Players use a custom Dolphin build +
> desktop launcher (separate `FoxTrotMelee` repo) that authenticate to this
> backend, get paired by our **own UDP match-rendezvous** (Slippi matchmaking is
> bypassed), and play; results auto-report to advance the bracket.

This repo is the **server + web** half of the product. The game client (Dolphin
fork) and the launcher live in **`FoxTrotMelee`** and are out of scope here.

> **New here? Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — it's the
> system map. `prisma/schema.prisma` is the source of truth for data models.

## What it does

- **Nightly regional tournaments** — three series (EU / NA-East / NA-West) at
  8 PM local, auto-created and run by the scheduler; double-elimination, Bo3/Bo5.
- **Own-auth, username identity** — players log in with username + password
  (no Slippi sign-in, no connect codes); JWT for the web, launcher, and in-game
  device-link.
- **Self-hosted match rendezvous** — a UDP registrar pairs bracket opponents
  directly; `mm.slippi.gg` is not used.
- **PvP arena, friends, series, chat, feed** — the social surface.
- **Stripe subscriptions** — wired but **dormant** under the current free
  release (nightly events are free).

## Tech stack

| | |
|---|---|
| **Backend** (`apps/api`) | Node 20 + TypeScript, Fastify, Prisma (PostgreSQL 16), Redis, Socket.io, `@slippi/slippi-js`, Stripe, AWS SES/S3 |
| **Web** (`apps/web`) | React 18, Vite, TypeScript, Tailwind, TanStack Query, Zustand, React Router, socket.io-client |
| **Shared** (`packages/shared`) | Double-elimination bracket engine + shared types |

## Layout

```
apps/api/            Fastify backend  (src/{index.ts,plugins,routes,lib}, udpRegistrar.ts)
apps/web/            React + Vite SPA (src/{App.tsx,pages,components,hooks,lib,types})
packages/shared/     bracket engine (bracket.ts) + types (index.ts)
prisma/schema.prisma data models (source of truth)
docs/                ARCHITECTURE.md · DEPLOY.md · NIGHTLY_TOURNAMENTS.md · WEB_ROADMAP.md
docker-compose.yml   local postgres:16 + redis
```

## Getting started (development)

Prereqs: Node 20+, Docker (PostgreSQL + Redis).

```bash
npm install
docker compose up -d                 # postgres:16 + redis
cp apps/api/.env.example apps/api/.env   # fill in: DATABASE_URL, REDIS_URL, JWT_SECRET, Stripe (test) keys
npx prisma migrate deploy            # or `prisma migrate dev`
npm run dev                          # api (tsx watch, :3001) + web (vite, :5173)
```

To exercise the match-rendezvous locally, set `RENDEZVOUS_HOST=127.0.0.1`,
`RENDEZVOUS_UDP_PORT=41100` (and `READY_TIMEOUT_MINUTES=0` to disable the
no-show sweep during a staged E2E). Full env matrix: [`docs/DEPLOY.md`](docs/DEPLOY.md) §9.

## Scripts

| Command | What |
|---|---|
| `npm run dev` | run api + web together |
| `npm run build` | build all workspaces (`tsc`; web also `vite build`) |
| `npm test -w apps/api` | API test suite (Vitest, 74 tests) |
| `npx vitest run` in `packages/shared` | bracket-engine tests (15) |

> Note: a root/app **ESLint config is not present**, so `npm run lint` is a
> no-op today — typecheck (`tsc`) + Vitest are the gates.

## Verification & deploy

`tsc` across all three packages + the Vitest suites are the correctness gates.
Deployment (AWS Elastic Beanstalk compose-mode + CloudFront + UDP rendezvous,
CI/CD via GitHub Actions — **a push to `main` auto-deploys production**) is
documented in [`docs/DEPLOY.md`](docs/DEPLOY.md). Product/roadmap detail lives in
[`docs/NIGHTLY_TOURNAMENTS.md`](docs/NIGHTLY_TOURNAMENTS.md) and
[`docs/WEB_ROADMAP.md`](docs/WEB_ROADMAP.md).

## Repos & licensing

- **This repo (`FoxTrot`)** — backend + web; private.
- **`FoxTrotMelee`** — the custom Dolphin build and the launcher (Electron fork
  of slippi-launcher), distributed as GPL-2.0+ in their own repos. Not modified
  from backend/web work.
