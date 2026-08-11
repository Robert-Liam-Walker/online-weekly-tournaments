# Online Weekly Tournament Series

A free, fully-online Super Smash Bros. Melee tournament that runs **inside the game**
— every Friday at 8PM Eastern.

No start.gg. No Discord wrangling. No messaging your opponent to start the set. You
launch Melee, press A to register, and the bracket runs itself: pairing, stage
striking, result reporting, and advancement all happen in-game.

**Live:** [onlineweeklytournaments.com](https://onlineweeklytournaments.com)

This repo is the **backend and website**. The game client — a Slippi Dolphin fork with
the in-game tournament scenes — lives in
[`online-weekly-tournaments-melee`](https://github.com/Robert-Liam-Walker/online-weekly-tournaments-melee).

---

## What players see

The entire tournament UX is rendered inside Melee itself. These are real screenshots
from the client, not mockups.

| | |
|:--:|:--:|
| <img src="docs/images/online-play.png" alt="Melee 1-P menu with Online Play highlighted" width="100%"> | <img src="docs/images/bracket-winners.png" alt="In-game winners bracket" width="100%"> |
| **1. Open Online Play** — straight into tonight's tournament, no sign-in. | **2a. The winners bracket** — press Y for the full double-elim bracket. |
| <img src="docs/images/bracket-losers.png" alt="In-game losers bracket" width="100%"> | <img src="docs/images/character-select.png" alt="Melee character select showing the player's tournament name" width="100%"> |
| **2b. Losers bracket** — press Down to flip sides and fight back. | **3. Character select** — no rank, no clutter, your tournament name above it. |
| <img src="docs/images/stage-strike.png" alt="In-game stage striking screen" width="100%"> | <img src="docs/images/match.png" alt="A live Melee match on Slippi rollback netcode" width="100%"> |
| **4. Strike for stage** — loser of each game counterpicks the next. | **5. Play your set** — Slippi rollback; the result reports itself. |

That bracket is drawn by the game, from this API's data. When a set ends, Slippi's
authoritative result is sent back over EXI and the bracket advances on its own.

---

## How the system fits together

```
   PLAYER PC                          AWS (us-east-1)
   ---------                          ---------------
   Slippi Dolphin fork  --HTTPS-->  CloudFront --> Elastic Beanstalk
     - in-game scenes                  |            (ONE Node process)
     - EXI + HTTP client               |             - Fastify REST
     - UDP announce                    |             - Socket.io
          |                            |             - UDP registrar :41100
          |                            v             - scheduler
          |                     S3 (React SPA)            |
          |                                               v
          +---- UDP :41100 -------------------->  Postgres (RDS) + Redis
                (NAT hole-punch, then the match      (durable)     (presence,
                 itself is peer-to-peer)                            locks, rdv)
```

Two independent transports:

- **Control plane** — REST and websockets ride HTTPS through CloudFront to Fastify.
- **Match plane** — the UDP rendezvous can't traverse CloudFront, so clients hit the
  registrar directly. Once it has swapped the two players' public endpoints, the
  actual game traffic is **peer-to-peer** and never touches our servers.

The rendezvous registrar is what replaces Slippi's closed-source matchmaking server.
The rollback netcode itself is inherited unchanged from the GPL Dolphin fork.

---

## Repo layout

A workspace monorepo. Three workspaces share the bracket engine.

```
.
├── prisma/
│   ├── schema.prisma          single source of truth for the data model
│   └── migrations/            `prisma migrate deploy` runs these on boot
├── packages/
│   └── shared/                @foxtrot/shared — pure, no IO
│       └── src/bracket.ts     the double-elimination engine
├── apps/
│   ├── api/                   Fastify backend
│   │   └── src/
│   │       ├── index.ts       composition root
│   │       ├── udpRegistrar.ts        stateless UDP shell
│   │       ├── routes/                one module per REST surface
│   │       └── lib/
│   │           ├── bracketService.ts  engine ↔ DB bridge
│   │           ├── rendezvous.ts      pairing state machine (Redis)
│   │           └── scheduleTournaments.ts
│   └── web/                   React + Vite SPA
└── docs/
    └── ARCHITECTURE.md        the full system map — start here
```

**The hard rule:** `packages/shared` is pure — no Prisma, no Redis, no `fetch`. That is
what lets the bracket engine be unit-tested exhaustively and reused identically
everywhere else.

---

## The bracket engine

The most interesting code in the repo is `packages/shared/src/bracket.ts`, and the
design decision behind it: **engine state is never serialized.**

`TournamentMatch` rows are the only persisted bracket state. To compute anything, the
service rebuilds the pure engine from `(seeded entries) + (recorded winners)` by
replay, mutates it, then mirrors the result back into rows:

```
every mutation  =  rebuild → mutate → persist
```

Because that's a read-modify-write, every mutation runs under a per-tournament Redis
mutex. Recorded results that don't replay cleanly throw rather than silently diverge.

Internally the bracket is a **dataflow graph** — each slot is either a seed, the winner
of another match, or the loser of another match — and `propagate()` is a fixpoint loop
that resolves slots and auto-completes byes until nothing changes. Byes are how
check-in no-shows are handled for free.

Match keys are stable strings every layer references: `W1-3`, `L4-1`, `GF`, `GFR`.

---

## Tech stack

| Layer | Choice |
|---|---|
| API | Fastify, TypeScript, `@fastify/jwt`, helmet, Redis-backed rate limiting |
| Realtime | Socket.io, sharing Fastify's HTTP server (one port) |
| Pairing | `dgram` UDP registrar, Redis-backed state machine |
| Database | PostgreSQL 16 via Prisma |
| Cache / coordination | Redis — presence, rate limits, rendezvous, per-tournament locks |
| Web | React 18, Vite, Tailwind, TanStack Query, Zustand |
| Infra | Elastic Beanstalk (Docker), RDS, ElastiCache, S3 + CloudFront, SES |
| CI/CD | GitHub Actions → ECR/EB (api), S3 + CloudFront invalidation (web) |

---

## Local development

**Prerequisites:** Node 20+, Docker.

```bash
npm install

# Postgres + Redis
docker compose up -d

cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env

npx prisma migrate dev

npm run dev          # runs api + web together
```

Run the tests:

```bash
npm test --workspace=packages/shared    # bracket engine
npm test --workspace=apps/api           # API unit tests
```

The UDP registrar is **opt-in** — it only binds when `RENDEZVOUS_UDP_PORT` is set, so
local dev and parallel test runs never fight over the socket.

---

## Rules of the series

1. 16-player double elimination, best of 3.
2. Standard Melee ruleset: 4 stocks, 8-minute timer, items off.
3. Legal stages: Battlefield, Final Destination, Pokémon Stadium, Yoshi's Story,
   Fountain of Dreams, Dream Land 64.
4. Game one's stage is decided by striking; the loser of each game picks the next.
5. No stalling.
6. Three no-shows is a ban.
7. Play fair and be respectful.

---

## Project status

This is a working MVP running real weekly events, with deliberate gaps. The honest
list, kept current in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §17:

- **Availability** — API, websockets, UDP registrar, and scheduler are all one process
  on a single instance. Simple and cheap; also a single point of failure. Scaling out
  needs the Socket.io Redis adapter, sticky sessions, and an NLB for UDP.
- **Integrity** — result reporting is participant-trust in v1. Replay verification
  flags mismatches but is not yet authoritative.
- **Observability** — no error tracking, metrics, or alerting yet. The scheduler
  heartbeat log is the only liveness signal.
- **Environments** — no staging; `main` deploys straight to production.

---

## Naming note

The product has been rebranded several times. The user-facing brand is **Online Weekly
Tournament Series**; the git history, code identifiers, AWS resource names, and
`FOXTROT_*` env vars still use `foxtrot` as the internal codename. Treat it as such
when reading the source.
