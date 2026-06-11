import { getIO } from "../plugins/socket";

export type TournamentUpdateKind =
  | "entry" // someone registered
  | "checkin" // someone checked in
  | "started" // bracket generated (manual or scheduler auto-start)
  | "result" // a match result was reported
  | "completed"; // final result reported, tournament over

/**
 * Broadcast a tournament state change to all connected web clients.
 * Clients filter on tournamentId; payload is intentionally tiny — receivers
 * refetch GET /api/tournaments/:id rather than trusting pushed state.
 * No-op if Socket.io hasn't been initialized (e.g. standalone scripts).
 */
export function emitTournamentUpdate(tournamentId: string, kind: TournamentUpdateKind) {
  getIO()?.emit("tournament:update", { tournamentId, kind });
}
