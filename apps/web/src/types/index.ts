export type SubscriptionStatus = "FREE" | "ACTIVE" | "PAST_DUE" | "CANCELED";
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
  connectCode: string;
  subscriptionStatus: SubscriptionStatus;
  subscriptionEndsAt?: string;
}

export interface ArenaEntry {
  id: string;
  userId: string;
  user: Pick<User, "id" | "username" | "connectCode">;
  format: Format;
  note?: string;
  createdAt: string;
}

export interface Challenge {
  id: string;
  challengerId: string;
  challengedId: string;
  challenger: Pick<User, "id" | "username" | "connectCode">;
  challenged: Pick<User, "id" | "username" | "connectCode">;
  format: Format;
  status: ChallengeStatus;
  seriesId?: string;
  createdAt: string;
}

export interface Series {
  id: string;
  player1Id: string;
  player2Id: string;
  player1: Pick<User, "id" | "username" | "connectCode">;
  player2: Pick<User, "id" | "username" | "connectCode">;
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
  _count?: { entries: number };
}
