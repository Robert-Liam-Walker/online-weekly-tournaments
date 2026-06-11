import { redis } from "./redis";

// Tournament lobby presence, backed by short-TTL Redis keys.
//
// The game client polls GET /api/tournaments/:id/ready every ~5s while the
// player sits in the tournament lobby/scene; each poll refreshes the key.
// A player whose key has expired has not polled for PRESENCE_TTL_SECONDS
// and is treated as absent by the no-show sweep (bracketService.sweepNoShows).

const PRESENCE_TTL_SECONDS = 30;

function presenceKey(tournamentId: string, userId: string): string {
  return `foxtrot:presence:${tournamentId}:${userId}`;
}

/** Record a liveness heartbeat for the player in this tournament (TTL 30s). */
export async function markPresent(tournamentId: string, userId: string): Promise<void> {
  await redis.set(presenceKey(tournamentId, userId), "1", "EX", PRESENCE_TTL_SECONDS);
}

/** True if the player has heartbeated within the last PRESENCE_TTL_SECONDS. */
export async function isPresent(tournamentId: string, userId: string): Promise<boolean> {
  return (await redis.exists(presenceKey(tournamentId, userId))) === 1;
}
