# Randall's Nightly Tournaments

Product plan from Robert's notes (2026-06-11). Supersedes the "weekly
Saturday events" cadence as the flagship product; the existing tournament
machinery (engine, registration/check-in, auto-report, no-show DQ, replay
verification, admin tools) is the foundation — this plan is mostly economy,
scheduling, and match-flow upgrades on top of it.

## Vision

Nightly bracket tournaments, every region, every night at 8pm local.
Players buy **tokens** on the website; everything else — region, series,
registration, playing — happens inside the game. "It's all in the website"
as the system of record and the pretty bracket/results view; Slippi/Dolphin
is just how you play. The Slippi-side logic stays as thin as possible.

**Name:** Randall's Nightly Tournaments (Randall: the Pokémon Stadium cloud
— Melee-native, memorable).

## Product spec

### Series grid: 9 nightly series

3 regions × 3 tiers, every night at **8pm region-local**:

| | Free | Small buy-in | Large buy-in |
|---|---|---|---|
| **East** (America/New_York) | 8pm ET | 8pm ET | 8pm ET |
| **Central** (America/Chicago) | 8pm CT | 8pm CT | 8pm CT |
| **West** (America/Los_Angeles) | 8pm PT | 8pm PT | 8pm PT |

(Region set v1 = US-only; the model must make adding regions trivial.)

**Timezone display rule:** an event always shows its REGION time ("8pm
Eastern") plus the viewer's local time ("7pm your time" for a Central
player viewing an East event). In-game: derive viewer-local from the PC
clock; web: from the browser. Events are stored as UTC instants (already
the convention since the scheduler UTC fix).

### Tokens

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

1. Hears about Randall's Nightly Tournaments on Reddit → visits website.
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

### Payouts (DECISION needed — math must check out)

Notes: 1st = 70%, 2nd = "a bit more than money back", 3rd = money back.
For an 8-player bracket at entry E (pool = 8E), the only split satisfying
all three constraints with no rake is exactly:

- 1st: 70% (5.6E) · 2nd: 17.5% (1.4E) · 3rd: 12.5% (1.0E) — totals 100%.

That leaves **zero platform revenue from the pool**, so the rake has to
live somewhere else. Options:
- **A (recommended):** rake on token purchase (sell tokens at a spread)
  and/or a cash-out fee — pools stay 100%-paid, marketing-friendly
  ("we never touch the pot").
- **B:** shave the split (e.g. 65/17.5/12.5 + 5% rake) — simpler books.
- Splits for non-8 bracket sizes scale by percentage of pool, with 3rd ≈
  entry refunded as the anchor.

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

### CI/CD (DECISION)

Notes say AWS CodePipeline. **GitHub Actions → ECR → EB is already built,
proven green end-to-end today** (version-asserted deploys, rerun-safe).
Recommendation: keep GH Actions; CodePipeline would re-implement the same
thing for no gain. Revisit only if we outgrow Actions (private runners,
AWS-internal triggers).

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

### P4 — Paid tiers + payouts (gated on compliance)
- Small/large tiers on; entry debits; payout credits live; Stripe Connect
  cash-out last, behind KYC/geo/age gates.

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

## Open questions for Robert

1. Rake model A (purchase spread / cash-out fee, pools 100% paid) or B
   (pool rake)?
2. Confirm: keep GitHub Actions over CodePipeline?
3. Cash-out in the first paid release, or paid-entry-with-token-prizes
   first and cash-out later?
4. Bracket size per tier — fixed 8? larger for free?
5. Region set v1 — the 3 US regions only?
