# Architecture

Online Nightly Tournament Series — a fully-online, nightly Melee tournament that runs
inside a Slippi Dolphin fork, with a companion website. This document is the
system map; it also calls out what is MVP vs. what is needed for a hardened
production launch.

## System overview

```
Browser ─► CloudFront ─┬─► S3                (React/Vite static site)
                       └─► Elastic Beanstalk (Fastify API — Docker, ONE t3.small)
                                 ├─ RDS PostgreSQL 16   (Single-AZ db.t4g.micro, Prisma)
                                 ├─ ElastiCache Redis    (single t4g.micro — presence, rate-limit, rendezvous)
                                 └─ UDP rendezvous :41100 (same instance)
Dolphin client (GPL Slippi fork, EXI tournament scene)
   ├─ device-link auth ─► API
   ├─ reads bracket/events ─► API (REST over HTTPS via CloudFront)
   └─ paired by the UDP rendezvous ─► P2P Slippi rollback netplay (direct between players)

SES (email — sandbox), Stripe (payments — dormant), GitHub Actions (CI/CD)
```

## Components

- **Web** — React + Vite, React Query, Zustand, socket.io-client. Built to a
  static bundle, served from a private S3 bucket behind CloudFront
  (randallsnightly.com). The client centers on a single nightly tournament
  (`/tournament`); public read, auth-gated actions.
- **API** — Fastify (Node, TypeScript) in Docker on **one** Elastic Beanstalk
  instance. JWT auth (`@fastify/jwt`), rate limiting (Redis store), helmet.
  CloudFront routes `/api/*` and `/socket.io/*` to it.
- **Database** — RDS PostgreSQL 16 (Single-AZ, db.t4g.micro) via Prisma;
  migrations run on boot (`prisma migrate deploy`).
- **Cache / presence** — ElastiCache Redis (single node): `/ready` presence for
  the no-show sweep, rate-limit store, and rendezvous token state.
- **Realtime** — Socket.io on the single API instance. Each connection joins a
  personal room `user:<id>`; channel/series rooms exist too. Used for tournament
  updates, challenges, and direct messages.
- **Matchmaking** — a self-hosted **UDP rendezvous registrar** (port 41100) on
  the API instance. It pairs the two real bracket opponents and hands them each
  other's endpoints; the match itself is **Slippi rollback netplay**, P2P,
  inherited from the GPL Dolphin fork (Slippi's matchmaking *server* is
  closed-source, so this replaces it; the netcode is Slippi's).
- **Game client** — Slippi Dolphin fork with a custom EXI tournament scene
  (`ssbm-c/Scenes/FoxTrot`) and in-game identity. Authenticates via device-link.
  Distributed as a portable `.zip` on a public S3 bucket
  (`nts-downloads-826671498662`); source repos are private.
- **Scheduler** — dependency-free `setInterval` loop that creates the nightly
  event and runs the no-show sweep.
- **Email** — SES (currently **sandbox**; production access denied — only
  verified recipients receive mail).
- **Payments** — Stripe integrated but **dormant** (free-only release).
- **CI/CD** — GitHub Actions: push to `main` → build → ECR/EB (api) and
  S3 + CloudFront invalidation (web).

## Subsystem: Direct messages (entrant-to-entrant chat)

The Messenger lets entrants DM each other from the tournament page (speech-bubble
next to each entrant) via a Facebook-Messenger-style dock in the bottom-right.

**Data model** — reuses the existing `ChatMessage` table (no new migration). A
DM is a deterministic two-person *channel*: `dm:<idA>:<idB>` with the ids sorted,
so the same pair always maps to one channel. `ChatMessage` is
`{ id, channel, userId (sender), content, createdAt }`, indexed on
`(channel, createdAt)`.

**API** (`apps/api/src/routes/messages.ts`, all `requireAuth`):
- `GET  /api/messages` — conversation list: scans the caller's recent DM rows
  and reduces to the latest message per channel (peer + last message).
- `GET  /api/messages/:userId` — thread history with one user (last 50, ascending).
- `POST /api/messages/:userId` — send; writes a `ChatMessage` and pushes it.

**Realtime** — on send, the route emits `dm:message` to both participants'
personal rooms (`user:<sender>` and `user:<recipient>`) via the shared Socket.io
instance. The web client listens for `dm:message` and refetches; a 15s poll is
the fallback.

**Frontend** — `components/Messenger.tsx` (global dock, rendered in the Layout),
`hooks/useMessenger.ts` (a tiny store so the entrants list can open a specific
chat), React Query for list/history. **Unread state is client-side only**
(localStorage `dm_read_<peerId>`); the server stores no per-user read state.

### Is it legit?

For an MVP, yes: messages are persisted in Postgres, auth-gated, delivered in
realtime over the existing socket infrastructure, and reuse a proven model
(no schema risk). It is **not** yet production-hardened.

### What it needs to be production-grade

1. **Abuse & safety (highest priority for user-to-user chat).** Today anyone can
   DM anyone, unlimited. Needs: per-user DM **rate limiting**, **block/mute**,
   **report**, and basic moderation. Without these, DMs are a harassment/spam
   vector.
2. **Server-side read state.** Unread is localStorage-only, so it doesn't sync
   across devices and can't power "seen" receipts. Needs a per-user,
   per-conversation `lastReadAt` (a `Conversation`/membership table or a read
   model).
3. **Scalable conversation model.** The list endpoint fetches ~200 recent rows
   and reduces in JS, and `channel contains <me>` is a substring scan that can't
   use the `(channel, createdAt)` index. At volume this needs a real
   `Conversation` + `ConversationMember` schema (indexed by user) with a
   denormalized last-message pointer, plus **pagination** ("load older" /
   cursor) for both list and history.
4. **Multi-instance realtime.** DM emits target `user:<id>` rooms, which only
   reach sockets on the same box. The moment the API runs >1 instance, add the
   **`@socket.io/redis-adapter`** (+ sticky sessions) or messages will be missed.
5. **Delivery & notifications.** No "delivered/read" receipts, no offline/push
   notifications, no unread email digest. Currently relies on socket + 15s poll.
6. **Retention & privacy.** No message deletion, retention policy, or data
   export/delete. Add these (and consider encryption-at-rest expectations)
   before handling real user data at scale.
7. **Tests.** No coverage for the messaging routes — add unit/integration tests
   (send, list ordering, history, auth boundaries, self-message rejection).

## Production-readiness (whole system)

Beyond messaging, the platform-wide gaps to a hardened launch:

- **Availability** — everything runs on one EB instance (API + sockets + UDP
  rendezvous = single point of failure). Move to ALB + ≥2 instances + autoscaling
  with sticky sessions and the Socket.io Redis adapter; relocate the UDP
  rendezvous (UDP can't traverse an ALB — needs an NLB or a dedicated registrar).
  Make RDS **Multi-AZ** with verified backups; add a Redis replica.
- **Security** — rotate the admin password and flagged secrets; get **SES
  production access** (account emails currently don't reach real users); add a
  CloudFront WAF; add JWT refresh/revocation.
- **Observability** — add error tracking (e.g. Sentry), metrics, uptime
  monitoring, and alerting; today an outage is discovered by players.
- **Environments** — add a **staging** environment; deploys currently go
  straight to prod `main`.
- **Integrity** — result reporting is participant-trust; replay verification
  flags LRAS games as MISMATCH (authoritative-result upgrade is backlogged); the
  "3 no-shows = ban" rule is stated but not enforced.
- **Legal** — the Dolphin fork is **GPL**; with the source repos now private but
  the binary distributed publicly, source availability to recipients is a
  compliance gap. Any future real-money payouts pull in KYC / 18+ / geo-gating.
- **Quality** — solid backend unit tests (79), but no frontend tests, no
  end-to-end test of register→play→report, no load testing, no ESLint config.
