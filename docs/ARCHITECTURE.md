# FoxTrot / Randall's Nightly Tournaments — Architecture

> System reference for the **FoxTrot** repo: the backend API (`apps/api`) and the
> website (`apps/web`) behind **Randall's Nightly Tournaments**. The custom
> Dolphin build and the desktop launcher live in a **separate repo**
> (`FoxTrotMelee`) and are out of scope here. This doc is the map; per-file
> headers/JSDoc (added throughout `src/`) are the detail.

## 1. What this is

Randall's Nightly Tournaments is a free, nightly, **regional** Super Smash Bros.
Melee tournament platform. Three regions (EU / NA-East / NA-West) each run an
8 PM-local nightly bracket. Players install the custom launcher + Dolphin, **log
in with a username + password against this backend** (no Slippi sign-in, no
connect codes), register/check in for the night's event on the web or in-game,
and the backend pairs bracket opponents over **our own UDP match-rendezvous**
(Slippi's matchmaking is bypassed). Game results auto-report to advance the
bracket.

This repo provides two of the three moving parts:

- **`apps/api`** — Fastify backend: auth, tournaments + bracket engine,
  scheduler, match-rendezvous (UDP), arena/challenges/friends/series/chat,
  replays, Stripe subscriptions (currently dormant), launcher manifest,
  device-link.
- **`apps/web`** — React/Vite website: marketing landing, login + account,
  tournaments + live bracket, arena, friends, feed, settings, admin, device
  link, Stripe pages.
- **`packages/shared`** — framework-agnostic bracket engine + shared types.

> **Heritage note:** the product began as a Slippi companion (weekly tournaments,
> connect-code identity, $5/mo-gated). It pivoted to own-auth + username identity
> + self-hosted rendezvous + free nightly regionals. Some older docs/strings may
> still say "connect code" or "$5/mo required" — the schema + this doc are
> current.

## 2. Repo layout

```
FoxTrot/
├── apps/
│   ├── api/        # Fastify backend (src/{index.ts,plugins,routes,lib}, udpRegistrar.ts)
│   └── web/        # React + Vite SPA (src/{App.tsx,pages,components,hooks,lib,types})
├── packages/
│   └── shared/     # DE bracket engine (bracket.ts) + shared types (index.ts)
├── prisma/
│   └── schema.prisma   # SOURCE OF TRUTH for all data models
├── docs/           # ARCHITECTURE.md (this), DEPLOY.md, NIGHTLY_TOURNAMENTS.md, WEB_ROADMAP.md
└── docker-compose.yml  # local postgres:16 + redis
```

## 3. Backend (`apps/api`)

**Bootstrap** — `src/index.ts` builds the Fastify app, registers plugins
(JWT, CORS, helmet, rate-limit, multipart, websocket/socket.io), mounts every
route module under `/api/*`, starts the tournament scheduler, and (when
`RENDEZVOUS_UDP_PORT` is set) the UDP registrar.

**Plugins** (`src/plugins/`)
- `auth.ts` — `requireAuth` (valid JWT → `request.user`), `requireAdmin`
  (role ADMIN), `requireSubscription` (active sub; mostly dormant under the
  free release). Guards send their own reply and the handler must return.
- `socket.ts` — Socket.io wiring for realtime arena/challenge/series/chat +
  `tournament:update`. ⚠️ Known gap (TODO): the socket JWT handshake currently
  decodes without verifying the signature — see findings (§8).

**Routes** (`src/routes/`, all under `/api`)
- `auth.ts` — register, login, `/me`, forgot-password → reset-password (sha256
  token, 60-min TTL, no user-enumeration). Admin bootstrap via `ADMIN_EMAIL`.
- `tournaments.ts` — list/detail, register, check-in, start, `/ready`
  heartbeat (advertises the rendezvous endpoint + match ticket), report,
  bracket, admin create/cancel/override. The bulk of the product surface.
- `device.ts` — device-link: client requests a code, player confirms it on the
  web while logged in, client exchanges it for a JWT.
- `replays.ts` — `.slp` upload + server-side parse/verification of a tournament
  set's result.
- `series.ts` / `challenges.ts` / `arena.ts` / `friends.ts` / `chat.ts` —
  the PvP/social surface (arena availability, direct challenges → series, Bo3/Bo5
  series reporting, friends, channel chat).
- `subscriptions.ts` + `webhooks.ts` — Stripe Checkout + billing portal; webhook
  consumes raw body (registered before the JSON parser) to verify signatures.
- `launcher.ts` — `/launcher/manifest` (Dolphin + gamefiles versions/sha256 +
  minVersion) the desktop launcher polls for auto-update.

**Lib** (`src/lib/`)
- `bracketService.ts` + `packages/shared/bracket.ts` — **double-elimination
  engine**. The bracket is **rebuilt by replaying `TournamentMatch` rows**
  (the DB is the source of truth); `matchKey` (e.g. `W1-2`, `L3-1`, `GF`,
  `GFR`) is the stable identifier, never an array index. Handles seeding/byes,
  winners/losers progression, grand-final reset, DQ cascade, no-show sweep.
- `scheduleTournaments.ts` — a dependency-free `setInterval` loop (NOT node-cron:
  node:20-slim ships no tzdata, which silently killed the old cron — see
  DEPLOY/CHANGELOG). Per minute: ensure tonight's 3 regional nightlies exist,
  start due tournaments, sweep no-shows; events `START_GRACE_MINUTES` (30) past
  their start that still can't begin are auto-CANCELED. Overlap guard + hourly
  `[scheduler] alive` heartbeat.
- `rendezvous.ts` + `udpRegistrar.ts` — self-hosted match rendezvous. `/ready`
  hands each player a ticket pointing at `RENDEZVOUS_HOST:PORT`; the two clients
  announce to the UDP registrar, which pairs them and returns each other's
  external endpoints. Redis-backed state, nonce/restart handling, silent drop of
  malformed/unknown packets (anti-reflector).
- `tournamentLock.ts` (per-tournament Redis mutex), `presence.ts` (Redis TTL
  presence from `/ready` polls; drives no-show detection), `regions.ts`
  (Region → display + IANA tz, DST math; **duplicated in `apps/web/src/lib`** —
  TODO consolidate to `packages/shared`), `email.ts` (SES vs dev-console
  backend; see §6), `slippi.ts` (`.slp` parse + winner attribution, with an LRAS
  caveat), `tournamentEvents.ts` (tiny `tournament:update` socket emit),
  `prisma.ts`/`redis.ts`/`stripe.ts` (client singletons + config guards),
  `replayStorage.ts` (S3 or local-disk backend).

## 4. Data model

`prisma/schema.prisma` is authoritative. Highlights:

- **User** — username (unique) + email + `passwordHash` + `role` (USER/ADMIN) +
  Stripe/subscription fields. **No connect code** (identity is username-only).
- **Tournament** — `scheduledAt`, `region` (EU/NA_EAST/NA_WEST, nullable for
  legacy/manual), `format` (SINGLE/DOUBLE_ELIM), `seriesFormat` (BO3/BO5),
  `status` (UPCOMING→REGISTRATION→ACTIVE→COMPLETED, or CANCELED). The
  `(region, scheduledAt)` pair is the scheduler's idempotency key.
- **TournamentEntry** — `seed`, `checkedInAt`, `dqAt`, `placement`
  (`@@unique([tournamentId, userId])`).
- **TournamentMatch** — `matchKey` + `round`/`matchNumber`, players, `winnerId`,
  `readyAt` (`@@unique([tournamentId, matchKey])`); source of truth for the
  bracket rebuild.
- **Series/Game/Challenge/ArenaEntry/Friendship/FriendRequest/ChatMessage** —
  the PvP/social surface.
- **DeviceLinkCode**, **PasswordResetToken** (hash-only, single-use, 60-min),
  **TournamentReplay** (parsed `.slp` evidence; `verification`
  PENDING/VERIFIED/MISMATCH/MANUAL_REVIEW).

## 5. Tournament lifecycle (happy path)

1. **Scheduler** ensures tonight's regional events exist (REGISTRATION).
2. Player **registers**, then **checks in** (web or in-game).
3. At start time the scheduler **starts** the event (≥2 checked in) → bracket
   seeded → status ACTIVE; `<2` checked-in within grace → CANCELED.
4. Clients poll **`/ready`**; matched opponents get a rendezvous ticket and pair
   over UDP; Slippi mm is hosts-blocked.
5. Game ends → result reported (auto from the game, or admin/TO override) →
   `bracketService` advances; `.slp` may be uploaded for verification.
6. Bracket completes → placements; web + in-game brackets update live via
   `tournament:update`.

## 6. Auth, identity & email

- **Identity:** username + password, JWT (7-day). Register/login in
  `routes/auth.ts`; the launcher logs in and writes the token for Dolphin
  (launcher repo); in-game device-link is the alternate path.
- **Password reset:** `/forgot-password` → emailed single-use link →
  `/reset-password`. No authenticated "change password" endpoint exists.
- **Email (`lib/email.ts`):** `@aws-sdk/client-ses`, region pinned us-east-1,
  credentials from the **EB instance role**. Active only when `SES_FROM_EMAIL`
  is set (else dev-console fallback). **The instance role needs `ses:SendEmail`**
  — see DEPLOY §6 (this was a real prod gap, fixed via the `foxtrot-ses-send`
  inline policy). SES is still **sandboxed** (prod-access request DENIED;
  re-request backlogged) so only verified recipients receive mail.

## 7. Frontend (`apps/web`)

React 18 + Vite + TypeScript + Tailwind. Data via TanStack Query + axios
(`lib/api.ts`: same-origin `/api` or `VITE_API_URL`; JWT request interceptor;
401 → clear token + redirect to `/login`). Auth state in a Zustand store
(`hooks/useAuth.ts`, token persisted to `localStorage` as `foxtrot_token`).
Realtime via socket.io (`lib/socket.ts`). Routing in `App.tsx`: public routes
(landing/login/terms/privacy/download/forgot+reset), everything else behind
`RequireAuth`, `/admin` behind an ADMIN check. Pages cover arena, tournaments +
detail/bracket, friends, feed, series, settings, device, subscribe, admin.

## 8. Cross-cutting notes / known TODOs (from the 2026-06-13 doc pass)

- **`regions.ts` is duplicated** in `apps/api/src/lib` and `apps/web/src/lib` —
  consolidate to `packages/shared` (coordinate with the web bundle).
- **No ESLint config** in the repo (the `lint` scripts can't run). Verification
  is `tsc` + Vitest (`apps/api` 74 tests, `packages/shared` 15).
- **`socket.ts` JWT** is decoded without signature verification — harden.
- **`formatDate`** is duplicated across 3 web pages (Admin/Tournaments/
  TournamentDetail) — extract to a `lib` helper.
- **Logout** clears auth but doesn't call `disconnectSocket()` — stale socket
  until reload.
- `bracketService.sweepDqForfeits` rebuilds the engine per DQ (O(n)); the
  scheduler has no double-start guard. Both low-risk; see file headers.

## 9. Deployment & ops

See **`docs/DEPLOY.md`** (authoritative): single-instance Elastic Beanstalk in
**docker-compose mode** (publishes `80:3001` + `41100/udp`), CloudFront in front
of S3 (web) + EB (`/api/*`, `/socket.io/*`), `rdv.randallsnightly.com` → the EB
EIP directly for UDP (CloudFront can't proxy UDP). **A push to `main`
auto-deploys prod via GitHub Actions** (CI + Deploy API + Deploy Web). Local dev:
`docker compose up -d` then `npm run dev`.

## 10. The other repo (out of scope here)

The custom **Dolphin** build and the desktop **launcher** (Electron fork of
slippi-launcher) live in `FoxTrotMelee`. Per current operating rule, that repo —
game and launcher both — is **off-limits** from backend/web work; the only
contract between them and this repo is the HTTP API + the UDP rendezvous + the
launcher manifest.
