/**
 * types/index.ts — shared TypeScript types for the FoxTrot web app.
 *
 * These types mirror the Prisma schema / API response shapes. They are used
 * across pages, components, and hooks — do not rename or restructure without
 * updating all usages.
 *
 * ENUM-LIKE UNION TYPES
 * ──────────────────────────────────────────────────────────────────────────
 *   SubscriptionStatus  — user billing state (maps to Stripe subscription states)
 *   UserRole            — access level for the authenticated user
 *   ReplayVerification  — result of the server-side replay file integrity check
 *   Format              — match series length (Best of 3 or Best of 5)
 *   SeriesStatus        — lifecycle state of a head-to-head series
 *   ChallengeStatus     — lifecycle state of a matchmaking challenge
 *   TournamentStatus    — lifecycle state of a scheduled tournament
 *
 * ENTITY INTERFACES
 * ──────────────────────────────────────────────────────────────────────────
 *   User               — authenticated user returned by /auth/me and /auth/login
 *   ArenaEntry         — a player waiting in the matchmaking lobby (/arena)
 *   Challenge          — a BO3/BO5 challenge between two users (/challenges)
 *   Series             — a completed or in-progress match series (/series/:id)
 *   Tournament         — a scheduled bracket event (/tournaments)
 *   TournamentEntryDetail — a single entrant within a TournamentDetail
 *   TournamentMatchDetail — a single bracket match within a TournamentDetail
 *   TournamentDetail   — Tournament + entries + matches (detail endpoint)
 *   TournamentReplay   — a Slippi replay file uploaded for a tournament match
 */

/** Stripe-aligned billing state for a user account. */
export type SubscriptionStatus = "FREE" | "ACTIVE" | "PAST_DUE" | "CANCELED";

/** Access level. ADMIN unlocks the /admin page and the Admin nav link. */
export type UserRole = "USER" | "ADMIN";

/** Result of the server-side Slippi replay verification pass. */
export type ReplayVerification = "PENDING" | "VERIFIED" | "MISMATCH" | "MANUAL_REVIEW";

/** Series format — number of games in a match. */
export type Format = "BO3" | "BO5";

/** Lifecycle state of a head-to-head series. */
export type SeriesStatus = "IN_PROGRESS" | "COMPLETED" | "DISPUTED";

/** Lifecycle state of a matchmaking challenge. */
export type ChallengeStatus = "PENDING" | "ACCEPTED" | "DECLINED" | "CANCELED";

/** Lifecycle state of a scheduled tournament bracket. */
export type TournamentStatus =
  | "UPCOMING"
  | "REGISTRATION"
  | "ACTIVE"
  | "COMPLETED"
  | "CANCELED";

/**
 * Authenticated user.
 * Returned by POST /auth/login and GET /auth/me.
 * Stored in the useAuthStore; persisted as a JWT (not the object itself).
 */
export interface User {
  id: string;
  username: string;
  email: string;
  subscriptionStatus: SubscriptionStatus;
  /** ISO datetime; present only when subscription is ACTIVE or past-due. */
  subscriptionEndsAt?: string;
  // Added by /auth/me; may be absent from older payloads — treat missing as USER.
  role?: UserRole;
}

/**
 * A single player waiting in the matchmaking arena.
 * Returned by GET /arena as an array.
 * Updated in real time via "arena:join" / "arena:leave" socket events.
 */
export interface ArenaEntry {
  id: string;
  userId: string;
  /** Minimal user snippet — id and username only. */
  user: Pick<User, "id" | "username">;
  format: Format;
  /** Optional note displayed alongside the player's entry (e.g. "any format"). */
  note?: string;
  /** ISO datetime when the entry was created (used for display ordering). */
  createdAt: string;
}

/**
 * A BO3/BO5 challenge sent from one user to another.
 * Returned by GET /challenges/pending and emitted via "challenge:receive".
 * Transitions: PENDING → ACCEPTED (creates a Series) | DECLINED | CANCELED.
 */
export interface Challenge {
  id: string;
  challengerId: string;
  challengedId: string;
  /** Minimal snippet for the user who sent the challenge. */
  challenger: Pick<User, "id" | "username">;
  /** Minimal snippet for the user who received the challenge. */
  challenged: Pick<User, "id" | "username">;
  format: Format;
  status: ChallengeStatus;
  /** Set once the challenge is ACCEPTED and a Series is created. */
  seriesId?: string;
  createdAt: string;
}

/**
 * A head-to-head match series between two players.
 * Returned by GET /series/:id.
 * Status transitions: IN_PROGRESS → COMPLETED | DISPUTED.
 */
export interface Series {
  id: string;
  player1Id: string;
  player2Id: string;
  /** Minimal snippet for player 1. */
  player1: Pick<User, "id" | "username">;
  /** Minimal snippet for player 2. */
  player2: Pick<User, "id" | "username">;
  format: Format;
  /** Number of games won by player 1. */
  p1Wins: number;
  /** Number of games won by player 2. */
  p2Wins: number;
  status: SeriesStatus;
  /** Set when status === "COMPLETED". */
  winnerId?: string;
  createdAt: string;
  /** ISO datetime; set when status transitions to COMPLETED or DISPUTED. */
  completedAt?: string;
}

/**
 * A scheduled Melee tournament bracket.
 * Returned by GET /tournaments (list) and GET /tournaments/:id (detail base).
 *
 * region: typed as `string` and narrowed via `isKnownRegion()` in
 *   lib/regions.ts so unexpected server values degrade gracefully to the
 *   generic "other" list rather than causing a type assertion failure.
 */
export interface Tournament {
  id: string;
  name: string;
  description?: string;
  /** ISO datetime of scheduled start. */
  scheduledAt: string;
  format: "SINGLE_ELIM" | "DOUBLE_ELIM";
  seriesFormat: Format;
  status: TournamentStatus;
  maxEntrants: number;
  /** Entry fee in cents. 0 = free. */
  entryFee: number; // cents; 0 = free
  /** Total prize pool in cents accumulated from entry fees. */
  prizePool: number; // cents accumulated
  // "EU" | "NA_EAST" | "NA_WEST" on nightly events; absent on older rows.
  // Typed as string and narrowed via isKnownRegion() in lib/regions.ts so
  // unexpected server values degrade to the generic list instead of lying.
  region?: string;
  /** Entrant count from a Prisma `_count` include. */
  _count?: { entries: number };
  /** True when the viewing user is registered for this tournament. */
  viewerRegistered?: boolean;
  /** True when the viewing user has checked in. */
  viewerCheckedIn?: boolean;
  /** The viewing user's final placement, if completed. */
  viewerPlacement?: number | null;
}

/**
 * A single entrant record within TournamentDetail.
 * Includes seed, check-in time, DQ time, placement, and user snippet.
 */
export interface TournamentEntryDetail {
  id: string;
  userId: string;
  /** Assigned seed; null before seeding is run. */
  seed: number | null;
  /** ISO datetime of check-in; null if not yet checked in. */
  checkedInAt: string | null;
  /** ISO datetime of DQ; null/absent if not DQ'd. */
  dqAt?: string | null;
  /** Final placement; null until the bracket is completed. */
  placement: number | null;
  user: { id: string; username: string };
}

/**
 * A single bracket match within TournamentDetail.
 * matchKey is the bracket engine's canonical identifier (e.g. "W1-1").
 */
export interface TournamentMatchDetail {
  id: string;
  /** Bracket engine key, e.g. "W1-1" (Winners Round 1, Match 1). */
  matchKey: string;
  round: number;
  matchNumber: number;
  /** null when the slot is a bye or TBD. */
  player1Id: string | null;
  player2Id: string | null;
  /** null until the match is completed. */
  winnerId: string | null;
  /** ISO datetime when both players marked ready; null until then. */
  readyAt?: string | null;
}

/**
 * Full tournament detail — the Tournament list shape extended with entries
 * and matches arrays. Returned by GET /tournaments/:id.
 */
export interface TournamentDetail extends Tournament {
  entries: TournamentEntryDetail[];
  matches: TournamentMatchDetail[];
}

/**
 * A Slippi replay file uploaded for a specific tournament match.
 * Returned by the admin/replay endpoints.
 * verification transitions: PENDING → VERIFIED | MISMATCH | MANUAL_REVIEW.
 */
export interface TournamentReplay {
  id: string;
  tournamentId: string;
  /** Bracket engine match key identifying which match this replay is for. */
  matchKey: string;
  uploaderId: string;
  fileName: string;
  /** Melee stage ID parsed from the replay; null if parse failed. */
  stage: number | null;
  /** Game duration in frames parsed from the replay; null if parse failed. */
  durationFrames: number | null;
  /** Winner's in-game tag parsed from the replay; null if parse failed. */
  parsedWinnerName: string | null;
  verification: ReplayVerification;
  /** ISO datetime when the verification was resolved; null if PENDING. */
  resolvedAt: string | null;
  /** User id of the staff member who resolved the verification. */
  resolvedById: string | null;
  createdAt: string;
}
