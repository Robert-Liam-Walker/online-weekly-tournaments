/**
 * presence.ts — Per-tournament lobby presence, backed by short-TTL Redis keys.
 *
 * Purpose: Track which players are actively sitting in a tournament lobby so
 * the no-show sweep (bracketService.sweepNoShows) can distinguish absent players
 * (who should be auto-DQ'd) from present ones.
 *
 * Mechanism: The game client sends GET /api/tournaments/:id/ready every ~5 s
 * while the player is in the lobby scene. Each poll calls markPresent(), which
 * (re-)sets a Redis key with a 30-second TTL. A player whose key has expired
 * has not polled in the last PRESENCE_TTL_SECONDS and is treated as absent.
 *
 * This is distinct from arena presence (lib/redis.ts → ARENA_KEY), which tracks
 * the global matchmaking queue and is not TTL-backed.
 *
 * Key exports:
 *   markPresent — call on each /ready poll to refresh the player's TTL.
 *   isPresent   — returns true if the player has heartbeated within 30 s.
 *
 * Invariants:
 *   - PRESENCE_TTL_SECONDS (30 s) must remain larger than the client poll
 *     interval (~5 s) to avoid spurious absence detections between polls.
 *   - No explicit cleanup is needed: TTL expiry clears stale keys automatically.
 *   - Keys are namespaced foxtrot:presence:<tournamentId>:<userId> to avoid
 *     collisions with other Redis namespaces used in this API.
 */
import { redis } from "./redis";

const PRESENCE_TTL_SECONDS = 30;

function presenceKey(tournamentId: string, userId: string): string {
  return `foxtrot:presence:${tournamentId}:${userId}`;
}

/**
 * Record a liveness heartbeat for the player in this tournament.
 * Sets (or refreshes) a Redis key with a 30-second TTL.
 * @param tournamentId - the tournament the player is waiting in.
 * @param userId       - the player to mark present.
 *
 * Call this on every GET /api/tournaments/:id/ready poll response.
 */
export async function markPresent(tournamentId: string, userId: string): Promise<void> {
  await redis.set(presenceKey(tournamentId, userId), "1", "EX", PRESENCE_TTL_SECONDS);
}

/**
 * Returns true if the player has heartbeated within the last PRESENCE_TTL_SECONDS (30 s).
 * @param tournamentId - the tournament to check presence for.
 * @param userId       - the player to check.
 *
 * Used by bracketService.sweepNoShows to determine which ready-match players
 * are absent and should be auto-DQ'd.
 */
export async function isPresent(tournamentId: string, userId: string): Promise<boolean> {
  return (await redis.exists(presenceKey(tournamentId, userId))) === 1;
}
