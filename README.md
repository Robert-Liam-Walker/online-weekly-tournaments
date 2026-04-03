# FoxTrot

> A competitive Super Smash Bros. Melee platform built on top of [Project Slippi](https://slippi.gg), adding weekly tournaments, a PvP arena, friends lists, and best-of-five series play.

---

## What Is FoxTrot?

FoxTrot is a competitive layer that sits on top of the existing Slippi ecosystem. Players still use the official **Slippi Launcher** for all actual gameplay (Dolphin emulator + rollback netcode), but FoxTrot handles everything else:

- Scheduling and running **weekly tournaments** with brackets
- A **PvP arena** where players can list themselves as available and challenge each other (best of 3 or best of 5)
- A **friends list** with presence indicators and direct challenge
- **Series tracking** (best-of-3 and best-of-5) across multiple games
- **Stripe-powered subscriptions** ($5/month) for access to ranked features

---

## Architecture Decision: Webapp vs. Game Integration

After evaluating the Slippi codebase:

| Approach | Feasibility | Notes |
|---|---|---|
| Fork slippi-launcher (Electron) | Medium | Could add UI panels; still needs a backend for social features |
| Modify Dolphin emulator (C++) | Very Hard | Requires deep emulator knowledge; not worth it for social features |
| **Companion webapp + API (chosen)** | **High** | Slippi handles gameplay; FoxTrot handles matchmaking, social, and tournaments |

**Decision:** FoxTrot is a **full-stack web application**. Players use the Slippi Launcher as-is for gameplay. FoxTrot acts as the coordination and competition layer — challengers connect via Slippi direct connect (using their connect code), and results are submitted by uploading the `.slp` replay file, which FoxTrot verifies using `slippi-js`.

This means:
- No emulator modification required
- Works with every existing Slippi user today
- All features (arena, tournaments, friends, payments) live in the webapp
- `.slp` file upload = trustless result verification (server parses the replay)

---

## Feature Set

### 1. PvP Arena (SmashLadder-style)

Modeled after the classic SmashLadder arena UX:

- **"I'm available" toggle**: Players mark themselves as open to challenges; they appear in the live Arena list
- **Arena list**: Shows all currently available players with their connect code, character, region, preferred format (Bo3/Bo5), and connection quality indicator
- **Challenge flow**:
  1. Challenger clicks "Challenge" on a listed player
  2. Challenged player receives a real-time notification (WebSocket)
  3. They accept or decline (no penalty for declining)
  4. On accept: both players see each other's Slippi connect codes and open Slippi Launcher to play
- **Series tracking**: After each game, players report the score; after series completion, one player uploads the final `.slp` file for verification
- **Best of 3 / Best of 5**: Chosen by the challenger, confirmed by the challenged player

### 2. Weekly Tournaments

- **Scheduling**: Tournaments created by admins on a weekly cadence (e.g., every Saturday at 7PM ET)
- **Registration**: Players register with their Slippi connect code; requires active subscription
- **Bracket system**: Single elimination or double elimination, auto-seeded by Slippi rank (if available) or registration order
- **Match flow**: Same as Arena — players see their opponent's connect code, play on Slippi, upload `.slp` for verification
- **Best of 5** for all tournament matches (configurable per tournament)
- **Results**: Bracket updates in real time via WebSocket

### 3. Friends List

- Add friends by Slippi connect code or FoxTrot username
- See when friends are **online**, **in a match**, or **in the arena**
- Direct challenge from friends list (skips the public arena flow)
- Match history with friends

### 4. Subscriptions (Stripe)

- **$5/month** via Stripe Checkout
- Subscription required for:
  - Tournament registration
  - Ranked arena matches (with win/loss tracking)
  - Friends list (up to 50 friends)
- Free tier:
  - Browse the arena list
  - View tournament brackets
  - Unranked casual challenges (no record tracking)
- Stripe webhooks update subscription status in real time
- Graceful degradation when subscription lapses (existing data preserved)

### 5. Series / Match History

- All completed series stored with results, characters used, stage picks (parsed from `.slp`)
- Per-player win/loss record in Bo3 and Bo5 formats
- Head-to-head record between any two players
- Leaderboard by arena wins (weekly, all-time)

---

## Tech Stack

### Backend (`apps/api`)

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ / TypeScript |
| Framework | Fastify |
| Database | PostgreSQL 16 (via Prisma ORM) |
| Real-time | Socket.io |
| Cache / Presence | Redis |
| Replay Parsing | `@slippi/slippi-js` |
| Payments | Stripe (Node SDK) |
| Auth | JWT + refresh tokens (or Clerk) |
| File Storage | S3-compatible (replay uploads) |

### Frontend (`apps/web`)

| Layer | Technology |
|---|---|
| Framework | React 18 + TypeScript |
| Build | Vite |
| Styling | Tailwind CSS |
| State / Data | TanStack Query (React Query) |
| Real-time | Socket.io-client |
| Payments | Stripe.js / Stripe Elements |
| Routing | React Router v6 |

### Monorepo

```
foxtrot/
├── apps/
│   ├── api/          # Fastify backend
│   └── web/          # React frontend
├── packages/
│   └── shared/       # Shared TypeScript types
├── prisma/
│   └── schema.prisma # Database schema
├── docker-compose.yml
└── README.md
```

---

## Data Models (Core)

```prisma
model User {
  id            String   @id @default(cuid())
  username      String   @unique
  connectCode   String   @unique   // Slippi connect code e.g. "FOXT#123"
  email         String   @unique
  stripeCustomerId String?
  subscriptionStatus SubscriptionStatus @default(FREE)
  subscriptionEndsAt DateTime?
  createdAt     DateTime @default(now())

  friendsInitiated Friendship[] @relation("initiator")
  friendsReceived  Friendship[] @relation("receiver")
  arenaEntry       ArenaEntry?
  seriesAsP1       Series[]     @relation("player1")
  seriesAsP2       Series[]     @relation("player2")
  tournaments      TournamentEntry[]
}

model ArenaEntry {
  id         String   @id @default(cuid())
  userId     String   @unique
  user       User     @relation(fields: [userId], references: [id])
  format     Format   // BO3 or BO5
  note       String?  // optional "looking for serious matches" etc.
  createdAt  DateTime @default(now())
}

model Series {
  id         String   @id @default(cuid())
  player1Id  String
  player2Id  String
  player1    User     @relation("player1", fields: [player1Id], references: [id])
  player2    User     @relation("player2", fields: [player1Id], references: [id])
  format     Format
  p1Wins     Int      @default(0)
  p2Wins     Int      @default(0)
  status     SeriesStatus
  winnerId   String?
  replayKey  String?  // S3 key for uploaded .slp file
  tournamentMatchId String?
  createdAt  DateTime @default(now())
  completedAt DateTime?
}

model Tournament {
  id          String   @id @default(cuid())
  name        String
  scheduledAt DateTime
  format      BracketFormat
  status      TournamentStatus
  entries     TournamentEntry[]
  matches     TournamentMatch[]
}

enum Format { BO3 BO5 }
enum SubscriptionStatus { FREE ACTIVE PAST_DUE CANCELED }
enum SeriesStatus { PENDING IN_PROGRESS COMPLETED DISPUTED }
enum BracketFormat { SINGLE_ELIM DOUBLE_ELIM }
enum TournamentStatus { UPCOMING REGISTRATION ACTIVE COMPLETED }
```

---

## Real-Time Architecture

```
Browser (Socket.io client)
        |
        | (WebSocket)
        |
   Fastify + Socket.io server
        |
      Redis  <-- arena presence, socket session store
        |
   PostgreSQL  <-- persistent data
```

Key socket events:
- `arena:join` / `arena:leave` — player toggling availability
- `arena:snapshot` — full list of available players (on connect)
- `arena:update` — delta update when someone joins/leaves
- `challenge:send` — challenger sends challenge to specific player
- `challenge:receive` — challenged player receives notification
- `challenge:accept` / `challenge:decline`
- `series:update` — score update within a series
- `tournament:bracket_update` — live bracket changes

---

## Slippi Integration

FoxTrot does **not** modify Slippi or Dolphin. Integration works as follows:

1. **Identity**: Players register with their Slippi connect code; FoxTrot stores it as their competitive identity
2. **Matchmaking**: FoxTrot tells both players to open Slippi Launcher and use Direct Mode to connect via connect code
3. **Result verification**: After a series, one player uploads the `.slp` file(s); FoxTrot's API parses them using `@slippi/slippi-js` to extract:
   - Game winner (`gameEnd.placements`)
   - Characters used (`settings.players[].characterId`)
   - Stage (`settings.stageId`)
   - Match duration
4. **Trust model**: Server-side parsing of `.slp` means results cannot be manually falsified (the file was produced by the emulator)

### Slippi-js Usage (Backend)

```typescript
import { SlippiGame } from "@slippi/slippi-js";

export function parseReplay(buffer: Buffer) {
  const game = new SlippiGame(buffer);
  return {
    settings: game.getSettings(),
    metadata: game.getMetadata(),
    stats:    game.getStats(),
    winner:   game.getStats()?.overall
                  .sort((a, b) => b.killCount - a.killCount)[0],
  };
}
```

---

## Stripe Integration

### Flow

1. User clicks "Subscribe" → frontend calls `POST /api/subscriptions/create-checkout`
2. Backend creates Stripe Checkout Session, returns URL
3. User completes payment on Stripe-hosted page
4. Stripe sends `checkout.session.completed` webhook → backend activates subscription
5. On `customer.subscription.deleted` or `invoice.payment_failed` → backend downgrades to FREE

### Subscription Enforcement

```typescript
// Fastify preHandler hook
async function requireSubscription(request, reply) {
  if (request.user.subscriptionStatus !== "ACTIVE") {
    reply.code(403).send({ error: "Active subscription required" });
  }
}
```

---

## API Routes (Overview)

```
POST   /api/auth/register
POST   /api/auth/login
GET    /api/auth/me

GET    /api/arena                    # List available players
POST   /api/arena/join               # Mark yourself available [subscription]
DELETE /api/arena/leave

POST   /api/challenges               # Send a challenge [subscription]
PATCH  /api/challenges/:id/accept
PATCH  /api/challenges/:id/decline

GET    /api/series/:id
PATCH  /api/series/:id/score         # Report a game result
POST   /api/series/:id/replay        # Upload .slp file

GET    /api/friends                  # [subscription]
POST   /api/friends/request
PATCH  /api/friends/request/:id/accept
DELETE /api/friends/:id

GET    /api/tournaments
GET    /api/tournaments/:id
POST   /api/tournaments/:id/register # [subscription]

POST   /api/subscriptions/create-checkout
POST   /api/subscriptions/portal     # Stripe billing portal
POST   /api/webhooks/stripe          # Stripe webhook endpoint
```

---

## Getting Started (Development)

### Prerequisites

- Node.js 20+
- Docker (for PostgreSQL + Redis)
- A Stripe account (test keys are fine)

### Setup

```bash
git clone <repo>
cd foxtrot

# Install all dependencies
npm install

# Start local services
docker-compose up -d

# Copy env files
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env

# Fill in Stripe keys, database URL, etc.

# Run database migrations
npx prisma migrate dev

# Start both apps
npm run dev
```

### Environment Variables (API)

```env
DATABASE_URL=postgresql://foxtrot:foxtrot@localhost:5432/foxtrot
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-secret
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...           # Your $5/month price ID
S3_BUCKET=foxtrot-replays
S3_ENDPOINT=...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

---

## Roadmap

- [ ] Phase 1: Auth, user profiles, Stripe subscriptions
- [ ] Phase 2: Arena (real-time presence + challenge flow)
- [ ] Phase 3: Series tracking + `.slp` upload verification
- [ ] Phase 4: Friends list
- [ ] Phase 5: Weekly tournament system + brackets
- [ ] Phase 6: Leaderboards and match history
- [ ] Phase 7: Mobile-responsive polish, email notifications

---

## Contributing

This project is in early development. Architecture decisions are finalized above — see the roadmap for what's currently being built.

---

## License

MIT
