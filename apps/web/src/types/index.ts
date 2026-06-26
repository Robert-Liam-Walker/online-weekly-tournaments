export type SubscriptionStatus = "FREE" | "ACTIVE" | "PAST_DUE" | "CANCELED";
export type UserRole = "USER" | "ADMIN";
export type ReplayVerification = "PENDING" | "VERIFIED" | "MISMATCH" | "MANUAL_REVIEW";
export type Format = "BO3" | "BO5";
export type SeriesStatus = "IN_PROGRESS" | "COMPLETED" | "DISPUTED";
export type ChallengeStatus = "PENDING" | "ACCEPTED" | "DECLINED" | "CANCELED";
export type TournamentStatus =
  | "UPCOMING"
  | "REGISTRATION"
  | "ACTIVE"
  | "COMPLETED"
  | "CANCELED";

export interface User {
  id: string;
  username: string;
  email: string;
  subscriptionStatus: SubscriptionStatus;
  subscriptionEndsAt?: string;
  // Added by /auth/me; may be absent from older payloads — treat missing as USER.
  role?: UserRole;
}

export interface ArenaEntry {
  id: string;
  userId: string;
  user: Pick<User, "id" | "username">;
  format: Format;
  note?: string;
  createdAt: string;
}

export interface Challenge {
  id: string;
  challengerId: string;
  challengedId: string;
  challenger: Pick<User, "id" | "username">;
  challenged: Pick<User, "id" | "username">;
  format: Format;
  status: ChallengeStatus;
  seriesId?: string;
  createdAt: string;
}

export interface Series {
  id: string;
  player1Id: string;
  player2Id: string;
  player1: Pick<User, "id" | "username">;
  player2: Pick<User, "id" | "username">;
  format: Format;
  p1Wins: number;
  p2Wins: number;
  status: SeriesStatus;
  winnerId?: string;
  createdAt: string;
  completedAt?: string;
}

export interface Tournament {
  id: string;
  name: string;
  description?: string;
  scheduledAt: string;
  format: "SINGLE_ELIM" | "DOUBLE_ELIM";
  seriesFormat: Format;
  status: TournamentStatus;
  maxEntrants: number;
  entryFee: number; // cents; 0 = free
  prizePool: number; // cents accumulated
  // "EU" | "NA_EAST" | "NA_WEST" on weekly events; absent on older rows.
  // Typed as string and narrowed via isKnownRegion() in lib/regions.ts so
  // unexpected server values degrade to the generic list instead of lying.
  region?: string;
  _count?: { entries: number };
  viewerRegistered?: boolean;
  viewerCheckedIn?: boolean;
  viewerPlacement?: number | null;
}

export interface TournamentEntryDetail {
  id: string;
  userId: string;
  seed: number | null;
  checkedInAt: string | null;
  dqAt?: string | null;
  placement: number | null;
  user: { id: string; username: string };
}

export interface TournamentMatchDetail {
  id: string;
  matchKey: string;
  round: number;
  matchNumber: number;
  player1Id: string | null;
  player2Id: string | null;
  winnerId: string | null;
  readyAt?: string | null;
}

// One match of the full-size display bracket served before the tournament
// starts. player1/player2 are null where the slot is still TBD (no entrant
// yet, or an undecided earlier round).
export interface PreviewBracketMatch {
  matchKey: string;
  round: number;
  matchNumber: number;
  player1: { id: string; username: string } | null;
  player2: { id: string; username: string } | null;
}

export interface TournamentDetail extends Tournament {
  entries: TournamentEntryDetail[];
  matches: TournamentMatchDetail[];
  // Present pre-start (REGISTRATION/UPCOMING): the entire bracket with TBD slots.
  fullBracket?: PreviewBracketMatch[];
}

export interface TournamentReplay {
  id: string;
  tournamentId: string;
  matchKey: string;
  uploaderId: string;
  fileName: string;
  stage: number | null;
  durationFrames: number | null;
  parsedWinnerName: string | null;
  verification: ReplayVerification;
  resolvedAt: string | null;
  resolvedById: string | null;
  createdAt: string;
}
