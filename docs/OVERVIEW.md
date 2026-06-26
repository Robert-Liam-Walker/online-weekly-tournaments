# Online Nightly Tournament Series — backend + web (FoxTrot repo)

This repo is the **backend (`apps/api`)** and **website (`apps/web`)** for Nightly
Tournament Service. The game client (Slippi Dolphin fork, EXI tournament scene)
lives in the separate **FoxTrotMelee** repo.

- **Architecture:** see `docs/ARCHITECTURE.md` (system map + messaging subsystem +
  production-readiness gaps). Infra/deploy: `docs/DEPLOY.md`.
- **Stack:** API = Fastify + Prisma + PostgreSQL (RDS) + Redis (ElastiCache) +
  Socket.io, Docker on **one** Elastic Beanstalk instance. Web = React + Vite,
  React Query, Zustand, served from S3 behind CloudFront. CI/CD = GitHub Actions
  (push to `main` → deploy-api to ECR/EB and deploy-web to S3 + CloudFront).
- **Live:** https://onlineweeklytournaments.com. Push to `main` auto-deploys prod; red CI
  = real failure (no silent rollbacks).

## Local dev / preview

- Full stack needs Docker (Postgres + Redis) + the dev API. When Docker is down,
  preview the web against a throwaway mock: `apps/api/scripts/_mockview.ts`
  (in-memory canned API on :3001; **untracked, do not commit/deploy**) + the Vite
  dev server (`npm run dev -w apps/web`, proxies `/api` to :3001). The mock has no
  socket server, so realtime is inert in preview.
- Build/verify: `npm run build -w apps/web` (tsc + vite); `npx -w apps/api tsc
  --noEmit`; `npm test -w apps/api` (79 tests).

## Session log — 2026-06-17

**Prod login bug FIXED** (`apps/web/src/lib/api.ts`): `VITE_API_URL` was set with a
trailing `/api` while the client also appended `/api`, producing `/api/api/...`
→ 404 on every request incl. login. Now strips a trailing `/api`. (Earlier cache
theory was wrong — got the real symptom from a DevTools/Network capture.)

**Website redesign (LIVE):**
- Lands directly on the single nightly tournament at `/tournament` (no list, no
  sign-in wall). `/` redirects there. Secondary `/tournaments/:id` kept for admin
  deep links. Resolver: `pages/NightlyTournament.tsx`.
- Detail page (`pages/TournamentDetail.tsx`): renders the **full TBD bracket**
  pre-start, fits on screen (no horizontal scroll), grand finals aligned with the
  winners final, play time shown top-right (e.g. "8PM EDT"), how-to-play line.
- Removed Arena/Leaderboard/Friends/Feed from nav + routing (page code retained).
- **Settings merged into Profile** (`pages/Profile.tsx`: account + next tournament
  + in-game name + subscription; Slippi-folder section dropped). In-game name
  control extracted to `components/InGameName.tsx`.
- **About** page = three columns: About us + Rules + Gameplay (screenshots in
  `public/gameplay/`). Run by Panini, slippi.gg/user/wede-971.
- Download served from public S3 (see below); "Powered by Slippi's open-source
  rollback netcode".

**Repos private + S3 download:** `randalls-dolphin` and `randalls-launcher` made
**private** (FoxTrot/FoxTrotMelee already were). The client `.zip` is now hosted
on a public bucket **`nts-downloads-826671498662`** (public-read policy);
`pages/Download.tsx` points there. To ship a new client build: overwrite
`s3://nts-downloads-826671498662/Nightly-Tournament-Service-Win.zip` (same URL).
NOTE: GPL compliance gap — Dolphin fork source is private while the binary is
public.

**In-game TBD bracket (backend-only fix):** `buildPreviewBracket` was sized to the
registrant count (empty at 0 → in-game showed "No sets yet"). Consolidated into a
single `buildFullBracket(entries, maxEntrants, viewerId)` in
`apps/api/src/routes/tournaments.ts` that returns the full capacity-sized
double-elim skeleton (TBD where unfilled), served as BOTH `previewBracket`
(in-game) and `fullBracket` (web). No Dolphin rebuild needed — the client already
renders empty preview slots as "-".

**Direct messaging (LIVE):** entrant-to-entrant DMs. A DM is a deterministic
2-person channel `dm:<idA>:<idB>` on the existing `ChatMessage` model (no
migration). Routes in `apps/api/src/routes/messages.ts` (list / history / send);
realtime via per-user socket rooms (`dm:message`). Web: bottom-right Messenger
dock (`components/Messenger.tsx`) + `hooks/useMessenger.ts`, opened from a
speech-bubble next to each entrant. Unread is client-side (localStorage).

## In-game match flow (for reference)

Registered + 8pm start → bracket pairs you → client match-watch worker polls
`/ready` → you press **A (Play)** on the bracket; if your match is ready it hands
off to CSS (RANKED/Bo3) and connects via the self-hosted UDP rendezvous → Slippi
rollback; result auto-reports and advances the bracket. Not automatic — A per
match. Registration auto-checks-in; no-show sweep DQs absentees.

## Open / backlog

- **Messaging hardening** (deferred): per-user DM rate-limit, block/mute, report,
  moderation; server-side read state; scalable Conversation schema + pagination;
  Socket.io Redis adapter before scaling past 1 instance; tests.
- **Prod admin password still needs rotating.**
- **SES** still sandbox (prod access denied) — account emails don't reach real users.
- "3 no-shows = ban" rule is stated (About) but **not enforced**.
- Production-readiness (see ARCHITECTURE.md): single-instance SPOF → ALB + ≥2
  instances + Redis socket adapter + move UDP rendezvous off-box; RDS Multi-AZ;
  observability/alerting; staging env.
