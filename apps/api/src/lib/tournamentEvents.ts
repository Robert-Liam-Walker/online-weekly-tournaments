/**
 * tournamentEvents.ts — Socket.io tournament state-change broadcaster.
 *
 * Purpose: Emit real-time notifications to all connected web clients whenever
 * a tournament's observable state changes (new entry, check-in, bracket start,
 * match result, completion, cancellation). This is a thin emit helper; the
 * heavy work (bracket logic, DB writes) happens in bracketService.ts and
 * scheduleTournaments.ts — they call this after the mutation is committed.
 *
 * Design:
 *   Payloads are deliberately tiny: { tournamentId, kind }. Clients use the
 *   notification as an invalidation signal and refetch GET /api/tournaments/:id
 *   rather than trusting the pushed state. This avoids synchronization bugs
 *   where a pushed snapshot could arrive before or after a concurrent mutation.
 *
 *   emitTournamentUpdate is a no-op when Socket.io has not been initialized
 *   (getIO() returns undefined). This covers standalone scripts and tests that
 *   exercise bracketService without a live server.
 *
 * Key exports:
 *   TournamentUpdateKind  — union type of recognised event names.
 *   emitTournamentUpdate  — broadcast a tournament change to all clients.
 *
 * Invariants:
 *   - Emit AFTER the DB write is committed; never emit speculatively.
 *   - Callers in bracketService.ts use "result" for match results and
 *     "completed" only when isComplete(bracket) is true.
 *   - The socket event name "tournament:update" is the public client contract;
 *     do not change it without a coordinated client update.
 */
import { getIO } from "../plugins/socket";

export type TournamentUpdateKind =
  | "entry" // someone registered
  | "checkin" // someone checked in
  | "started" // bracket generated (manual or scheduler auto-start)
  | "result" // a match result was reported
  | "completed" // final result reported, tournament over
  | "canceled"; // TO canceled an upcoming/registration event

/**
 * Broadcast a tournament state change to all connected web clients.
 * Clients filter on tournamentId; payload is intentionally tiny — receivers
 * refetch GET /api/tournaments/:id rather than trusting pushed state.
 * No-op if Socket.io hasn't been initialized (e.g. standalone scripts).
 *
 * @param tournamentId - the tournament that changed.
 * @param kind         - the type of change that occurred.
 */
export function emitTournamentUpdate(tournamentId: string, kind: TournamentUpdateKind) {
  getIO()?.emit("tournament:update", { tournamentId, kind });
}
