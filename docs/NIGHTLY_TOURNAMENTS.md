# Online Nightly Tournament Series

Product plan from Robert's notes (2026-06-11). Supersedes the "weekly
Saturday events" cadence as the flagship product; the existing tournament
machinery (engine, registration/check-in, auto-report, no-show DQ, replay
verification, admin tools) is the foundation — this plan is mostly economy,
scheduling, and match-flow upgrades on top of it.

**Revised later the same day (2026-06-11): the release is FREE-only with
Stripe fully dormant** — tokens, pots, payouts, and subscriptions all move
to the paid phases. See the Decisions log for what superseded what.

## Vision

Nightly bracket tournaments, every region, every night at 8pm local.
Players buy **tokens** on the website; everything else — region, series,
registration, playing — happens inside the game. "It's all in the website"
as the system of record and the pretty bracket/results view; Slippi/Dolphin
is just how you play. The Slippi-side logic stays as thin as possible.

**Name:** Online Nightly Tournament Series (Randall: the Pokémon Stadium cloud
— Melee-native, memorable).

**Domain:** onlineweeklytournaments.com (registered 2026-06-11).

*(The token-buying flow above is the eventual paid product; the launch
release itself is free-only — see Revenue model.)*

## Product spec

### Nightly grid (REVISED 2026-06-11): 3 free events per night

3 regions × 1 free event, every night at **20:00 region-local**, named
like `Randalls Nightly — EU — Jun 13`:

| Region | IANA timezone | Start |
|---|---|---|
| **EU** (CET anchor) | Europe/Berlin | 8pm local |
| **NA East** | America/New_York | 8pm local |
| **NA West** | America/Los_Angeles | 8pm local |

US **Central is dropped**; EU is in from day one. The earlier
3-US-regions × 3-tiers = 9-series grid is deferred with the buy-in tiers
(see Revenue model); the model must still make adding regions trivial.

**Timezone display rule:** an event always shows its REGION time ("8pm
Eastern") plus the viewer's local time ("7pm your time" for a Central
player viewing an East event). In-game: derive viewer-local from the PC
clock; web: from the browser. Events are stored as UTC instants (already
the convention since the scheduler UTC fix).

### Tokens (DEFERRED — wholly in the paid phases)

Tokens, pots, and payouts move **entirely** to the paid phases. The free
release has no balances, no prize pools, no payouts — bragging rights
only. Original design kept below for when paid lands:

- Purchased on the **website** via Stripe Checkout (the only place money
  enters). One purchase → token balance on the account.
- Balance is **displayed in-game, top-right of the tournaments screen**,
  and updated after every entry/payout.
- Entry fees and payouts are denominated in tokens everywhere.
- **Cash-out (tokens → money): Stripe Connect.** Feasible, but it is the
  step that turns this into real-money skill gaming — gated behind the
  compliance workstream (below). Free + token-circulating play can ship
  long before cash-out does.

### Ideal user flow (canonical, from the notes)

1. Hears about Online Nightly Tournament Series on Reddit → visits website.
2. Downloads page → installs (FoxTrot Launcher). Optionally buys tokens.
3. Boots the game: token balance visible top-right. Picks region → picks
   series (free / small / large) → presses A to register. Done.
4. At 8pm region-local the bracket starts. Sees current opponent + a
   **countdown timer** for the match.
5. Presses A → matched against the opponent **through the same screens as
   Slippi ranked** (striking, counterpicks, Bo3 set flow).
6. Match auto-recorded; results auto-reported; bracket advances until a
   champion. Tokens credited per the payout table; balance updates.
7. Website shows the pretty bracket + results anytime.

### Revenue model (REVISED 2026-06-11 — supersedes the tiered model)

**Release: FREE. Stripe fully dormant.** No subscriptions, no tokens, no
pots at launch — the nightly regionals are the free on-ramp (which also
resolves the earlier funnel concern).

**Step 2 (post-release):** **$5/mo subscription** unlocking ranked-mode
and other member benefits. The repo's dormant Stripe subscription
infrastructure (User.subscriptionStatus, subscription routes + webhooks,
STRIPE_PRICE_ID) is the foundation when this lands.

**Later paid phases:** the token/pot economy ($10/$20 tiers, 70/17.5/12.5
pool payouts, Stripe Connect cash-out) as previously designed — all
behind the compliance workstream.

**Bracket size (REVISED): single double-elim, cap 32** (engine tested to
32; byes handle short fields). Parallel 8-player brackets are deferred to
the paid phases. Gated on Robert's in-game eyeball of the seeded 32-man
bracket (the per-column Text limit must be visually verified).

## Architecture

### Principles
- **Website = system of record + money.** All state lives in the FoxTrot
  API/DB (it already does). Stripe only on the web.
- **Game = selection + play.** Region/series choice, registration, match
  flow in-game. The EXI surface stays thin: balance display, series list,
  register, ready/countdown, report — most of this exists.
- **Dolphin logic minimal** — reuse Slippi's own ranked-mode machinery for
  the set flow instead of building parallel UX.

### Self-hosted matchmaking (replaces riding Slippi's service)

Notes: "copy the code from Slippi's ranked service and host it on my own
servers — they can't throttle me, their code is open source."

**Reality check:** Slippi's *client* is open source (GPL — our fork), and
it fully documents the matchmaking protocol (`SlippiMatchmaking.cpp`,
enet to mm.slippi.gg: ticket create/get, peer assignment, then P2P
rollback between clients). The matchmaking **server** itself is not
published. So the plan is not "copy their service" but **implement a
protocol-compatible matchmaking server** and point our fork at it
(`mm.foxtrot…` instead of `mm.slippi.gg`):

- Speaks the existing client protocol (so game-side stays stock Slippi).
- Auth against **our** accounts (device-link JWTs), not Slippi's user DB —
  this also retires the user.json/Firebase dependency for tournament play.
- Pairs exactly the two bracket opponents (we already know who plays whom
  — this is assignment, not a queue), then hands off to stock P2P
  rollback.
- Effect: no dependency on Slippi's production services for tournament
  matches → the "throttling/blocked server-side" risk from the launch plan
  largely dissolves (their Firebase login remains only for vanilla Slippi
  features in the launcher).

### CI/CD (LOCKED): GitHub Actions

Stays on GH Actions → ECR → EB (proven green end-to-end 2026-06-11,
version-asserted, rerun-safe). CodePipeline rejected as redundant.

### Compute
- EB env is up (api). The matchmaking server becomes a second small
  service (its own EB env or a container alongside) — enet/UDP, so it
  needs an EC2-ish home with UDP ports open, not an ALB.

## Compliance workstream (gates paid tiers + cash-out)

Paid entry + cash prizes = real-money skill gaming:
- **Stripe**: tournaments-of-skill require Stripe's review/approval;
  Connect for payouts adds KYC on recipients. Engage early.
- **Jurisdictions**: several US states restrict paid skill contests —
  geo-gating list needed; age gate (18+).
- **Taxes**: 1099/W-9 handling above payout thresholds (Stripe Connect
  helps here).
- Free tier + non-cashable tokens have no such gate — ship those first.

## Phases

### P0 — Lock decisions (days)
Rake model (A vs B) · CI/CD (keep Actions?) · cash-out at paid-launch or
later · bracket size/format per tier (8 double-elim default?) · regions v1.

### P1 — Token economy + nightly grid, FREE tier live (1–2 wk)
- Schema: `TokenBalance` (or `User.tokens`), `TokenTransaction` ledger
  (PURCHASE / ENTRY / PAYOUT / ADJUST, with refs); `Tournament` gains
  `region`, `tier`, `seriesKey` (e.g. `EAST-FREE-2026-06-12`).
- Stripe Checkout → token credit webhook (web "Buy tokens" page).
- Nightly scheduler: generalize the weekly cron → 9 series/night at 8pm
  region-local (UTC math per region; existing auto-start/cancel + no-show
  DQ apply as-is).
- In-game: token balance top-right (extend an existing EXI response, e.g.
  STATUS or event-list payload); region→series browse (the event browser
  already filters; add region pick); register debits tokens (free = 0).
- Web: buy-tokens page, balance, nightly grid with the dual-timezone
  display rule, bracket/results pages (exist).
- Payout engine: on completion, credit per the locked split (ledger
  entries; free tier = bragging rights only).

### P2 — Ranked-machinery match flow (the promoted backlog item) (1–2 wk)
- Bo3 sets + stage striking/counterpicks via Slippi's ranked-mode set
  machinery for tournament matches (research already in
  TOURNAMENT_INTEGRATION.md "Set format upgrade"); countdown timer on the
  opponent screen (deadline data exists via `readyAt` + timeout).
- Auto-record stays (replay verification pipeline exists; attach replays
  per set).

### P3 — Self-hosted matchmaking (2–3 wk, parallelizable with P2)
- Protocol-compatible mm server (enet) + device-link auth + bracket-pair
  assignment; fork config points at it; staging soak with two accounts.

### P4 — Paid launch: subscriptions, paid tiers, payouts AND cash-out
  (single gated release — LOCKED: cash-out ships with the first paid
  release, so the full compliance workstream fronts this phase)
- Subscription tiers $5/$10/$20 (extend the dormant Stripe subscription
  infra to three prices; registration gated by tier ⊆ subscription).
- Small/large pots live: entry debits, 70/17.5/12.5 payout credits.
- Stripe Connect cash-out with KYC, 18+ gate, state geo-blocking —
  Stripe review/approval is the long pole; start the conversation in P0.

### P5 — Smash 64 (separate project, after this ships)
Same product on SSB64: requires rollback-enabled Slippi-style
ranked/unranked for 64 first — **unranked first** (existing
smash64-ranked project / RMG-Gekkonet fork).

## What already exists (don't rebuild)

DE bracket engine + placements · registration/check-in + auto-start ·
no-show auto-DQ (presence via /ready) · auto-report from game result ·
replay upload/verification · admin/TO tools (DQ/override/reviews) ·
device-link auth · launcher + manifest pipeline · AWS staging + CI/CD ·
in-game event browser/lobby/bracket view.

## Decisions log

**Afternoon 2026-06-11 (superseded same day where noted):**
1. ~~Revenue = $5/$10/$20 subscription tiers~~ → SUPERSEDED by 5.
2. **CI/CD = GitHub Actions** (CodePipeline rejected). — LOCKED
3. **Cash-out ships WITH the first paid release** (compliance fronts the
   paid phase). — LOCKED (applies when paid lands)
4. ~~Brackets = 8 fixed + parallel overflow~~ → SUPERSEDED by 6.

**Evening 2026-06-11 (current):**
5. **Release = FREE-only, Stripe fully dormant.** Step 2 = $5/mo
   subscription for ranked-mode + member benefits. Tokens/pots/cash-out
   move wholly to later paid phases. — LOCKED
6. **Single 32-cap double-elim bracket** at release; parallel 8s
   deferred. Gated on the in-game 32-man UI eyeball. — LOCKED
7. **Regions v1 = EU (Europe/Berlin) / NA East / NA West at 20:00
   region-local** (US Central dropped). — LOCKED
8. **Domain = onlineweeklytournaments.com.** — LOCKED (registration pending
   Robert's registrant contact details)

## Still open

- Free-trial framing for the step-2 $5 subscription (decide at that
  launch's marketing pass)
