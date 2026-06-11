# FoxTrot Web Platform Roadmap

Reconciles the original README (companion-webapp era) with the current
product reality. **Product direction: FoxTrot = in-game tournament client +
web companion platform + backend.** The in-game loop is built and confirmed
(see `TOURNAMENT_INTEGRATION.md` in the FoxTrotMelee repo): event browser,
register/check-in, bracket match lookup, Slippi direct-connect handoff,
result reporting (auto from game data), placements, bracket view. The
website's job is to support that loop first; the generic ladder/arena
product is Phase 2.

The README's "FoxTrot does not modify Slippi or Dolphin" claim is
**outdated** — there is a custom Dolphin fork (FoxTrotMelee repo,
`dolphin/`) speaking EXI commands 0x20–0x2D to the in-game scene and HTTP
to this API. Old webapp assumptions remain valid as Phase 2 scope.

## Ground truth (verified 2026-06-11, not assumptions)

Already implemented and working in this repo:

- Monorepo structure as described: `apps/api` (Fastify+TS), `apps/web`
  (React+Vite), `packages/shared`, `prisma/schema.prisma`,
  `docker-compose.yml` (postgres:16 + redis:7).
- Auth (bcrypt+JWT), Stripe subscription routes/webhooks, arena routes,
  friends, series, replay parsing (`apps/api/src/lib/slippi.ts`,
  slippi-js 6.7 — winner calc fixed 2026-06-11), Socket.io plugin.
- Tournament backend (built for the in-game loop):
  - `packages/shared/src/bracket.ts` — pure double-elim engine, stable
    match keys (`W1-2`, `L3-1`, `GF`, `GFR`), bye auto-resolution,
    placements; 15 vitest tests incl. 500 random simulations.
  - `apps/api/src/lib/bracketService.ts` — engine↔Prisma bridge (rebuild
    by replay; TournamentMatch rows are the source of truth).
  - Routes: viewer-aware public `GET /api/tournaments` (+`viewerRegistered`,
    `viewerCheckedIn`, `viewerPlacement`), `GET /:id`, `POST /:id/register`
    (free + Stripe checkout), `POST /:id/checkin`, `POST /:id/start`,
    `GET /:id/ready` (player objects), `POST /:id/matches/:matchKey/report`
    (participant-guarded), `POST /api/auth/game-login` (connect code → JWT,
    **dev trust — replaced by device link before launch**).
  - Schedulers: weekly creation cron + per-minute auto-start (cancels <2
    check-ins).
  - Schema already has `matchKey` (unique per tournament), `checkedInAt`,
    `placement`.
  - Dev seeds: `apps/api/scripts/seed-dev-events.ts`, `seed-live-match.ts`;
    e2e smoke `scripts/smoke-tournament.ts`.

**Do not rename or remove fields/routes the game depends on** — the Dolphin
client (`FoxTrotTournament.cpp`) consumes `game-login`, the tournament list
(viewer flags, `entryFee`, `_count.entries`, `scheduledAt`, `status`),
`/ready` (player objects with `connectCode`), and the report route. Additive
changes only. A separate `/api/game/*` namespace is unnecessary — the game
uses the same routes as the browser, distinguished only by auth method.

## Build priorities

### Progress (2026-06-11)

- **A/B done:** `/tournaments` list + `/tournaments/:id` detail with a live
  bracket mirror (winners columns, GF topping the row, losers below;
  green/red/dim) — same filtering as the in-game view.
- **C done:** the detail page's bracket IS the live mirror.
- **D — DONE (API + web + Dolphin), awaiting in-game test.** `/device`
  page + the full `/api/device/link/{start,confirm,status}` flow with a
  one-shot 30-day JWT (DeviceLinkCode model); e2e `smoke-device-link.ts`
  passes. The Dolphin client (FoxTrotMelee repo) now prefers a persisted
  device-link token, falls back to `game-login`, and on a 404 surfaces a
  6-char code in-game (EXI 0x2E) for the player to confirm at `/device`;
  Dolphin built /WX-clean. Robert tests the in-game paths next.
- **E done:** replay attachment for tournament sets —
  `POST /api/replays/:tournamentId/matches/:matchKey/replay` (multipart),
  parse + winner cross-check → PENDING/VERIFIED/MISMATCH/MANUAL_REVIEW
  (`TournamentReplay` model); local disk storage with an S3 seam; 8 unit +
  9 smoke tests. **KNOWN BUG to fix (`apps/api/src/lib/slippi.ts`):**
  slippi-js 6.7 keys `metadata.players` by 0-based playerIndex but the code
  indexes by 1-based port, and `winner` returns a 0-based index while the
  interface documents a port — real replays would misattribute codes. The
  replay route follows the documented contract, so a mismatch degrades to
  MANUAL_REVIEW (never a false VERIFIED) until slippi.ts is fixed.
- **Realtime done:** Socket.io `tournament:update {tournamentId, kind}`
  emitted on register/checkin/start/report; web pages subscribe and refetch,
  polling kept as a 30s fallback.

### Phase 1 — support the confirmed in-game loop

A. **`/tournaments`** — public list. Same data the in-game browser shows
   (the API already serves it), plus registration/check-in state for the
   logged-in viewer.

B. **`/tournaments/:id`** — detail: schedule, registration/check-in state,
   entrants, active + completed sets, "play this from inside Melee via
   FoxTrot Dolphin" instructions.

C. **`/tournaments/:id/bracket`** — live set-list mirror of what the game's
   Y-button bracket view shows (same `matches` data). Poll first; Socket.io
   `tournament:bracket_update` after. A graphical bracket tree is polish.

D. **`/device`** — device link, the real-auth replacement for connect-code
   trust: `POST /api/device/link/start` (game asks, gets short code),
   user confirms on web while logged in (`/confirm`), game polls
   (`/status`) and receives its JWT. New models: `DeviceLinkCode`,
   `DeviceSession`. This unlocks removing `game-login`'s trust model.

E. **Replay attachment for tournament sets** — reuse the existing
   slippi-js parsing: `POST /api/tournaments/:id/matches/:matchKey/replay`
   (S3 in prod, local dev storage), parsed metadata persisted, winner
   cross-checked against the reported result → verification status
   `PENDING | VERIFIED | MISMATCH | MANUAL_REVIEW`. No MP4 conversion.

F. **TO/admin controls** — create/edit events from the web (POST exists),
   manual start, DQ/forfeit a player (engine handles byes already).

### Phase 1.5 — start.gg additive support

`tournament.source = NATIVE | STARTGG_LINKED` (+ `startggTournamentSlug`,
`startggEventId`, `registrationUrl`, `bracketUrl`). For STARTGG_LINKED
events the site links out for registration and mirrors bracket state;
FoxTrot stays source of truth for NATIVE events. The in-game browser can
show linked events with a "register on web" marker (the EXI protocol's
`USE WEBSITE` action result already covers this UX).

### Phase 2 — the original README product

Arena/challenges, friends, rankings, subscriptions gating ranked features.
Preserve what exists; don't prioritize above the tournament loop.
Subscriptions must not block development: dev `.env` uses placeholder
Stripe keys today (paid registration short-circuits to "use website"
in-game); add an explicit dev bypass flag when gating lands.

## First milestone (concrete)

The website shows the same live tournaments the in-game browser shows, with
a detail page and live set list. Registration/check-in done in-game appears
on the web (and vice versa — same rows). A result reported from the game
updates the web bracket page on refresh/poll.

## Realtime

Socket.io exists (`apps/api/src/plugins/socket.ts`, separate port). Wire
`tournament:bracket_update` / `tournament:match_update` / `device:linked`
when pages land; polling is acceptable for the first milestone.
