/**
 * redis.ts — ioredis client singleton + arena presence helpers.
 *
 * Purpose: Export a single shared Redis connection used throughout the API
 * (tournament locks, match rendezvous, lobby presence). Sharing one ioredis
 * instance avoids unnecessary TCP connections.
 *
 * Configuration:
 *   REDIS_URL — ioredis connection string (default: redis://localhost:6379).
 *   The client reconnects automatically on transient failures (ioredis default
 *   behaviour); no explicit retry config is needed for typical deployments.
 *
 * Arena presence (global matchmaking queue):
 *   Players who open the arena scene are tracked in a Redis Set (ARENA_KEY).
 *   The set is not TTL-backed — the game client explicitly calls add/remove on
 *   enter/leave. For per-tournament lobby presence (TTL-based), see
 *   lib/presence.ts.
 *
 * Key exports:
 *   redis        — the shared ioredis client; import this everywhere.
 *   ARENA_KEY    — Redis key for the global arena entry set.
 *   getArenaUserIds / addToArena / removeFromArena / isInArena — thin wrappers
 *   around the arena set; keep call-sites from knowing the key directly.
 *
 * Invariants:
 *   - Never create additional Redis instances; import `redis` from this module.
 *   - Arena membership is kept by the application, not by TTL; always call
 *     removeFromArena when a player leaves to avoid ghost entries.
 */
import Redis from "ioredis";

export const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

// Arena presence key helpers
export const ARENA_KEY = "arena:entries";

/**
 * Returns all userIds currently in the global arena queue.
 * The arena set is maintained by explicit add/remove (not TTL-backed).
 */
export async function getArenaUserIds(): Promise<string[]> {
  return redis.smembers(ARENA_KEY);
}

/**
 * Add `userId` to the global arena queue.
 * Idempotent — SADD is a no-op if the member already exists.
 */
export async function addToArena(userId: string): Promise<void> {
  await redis.sadd(ARENA_KEY, userId);
}

/**
 * Remove `userId` from the global arena queue.
 * Idempotent — SREM is a no-op if the member does not exist.
 */
export async function removeFromArena(userId: string): Promise<void> {
  await redis.srem(ARENA_KEY, userId);
}

/**
 * Returns true if `userId` is currently in the global arena queue.
 */
export async function isInArena(userId: string): Promise<boolean> {
  return (await redis.sismember(ARENA_KEY, userId)) === 1;
}
