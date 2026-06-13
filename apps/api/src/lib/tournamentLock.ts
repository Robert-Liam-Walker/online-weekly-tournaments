/**
 * tournamentLock.ts — Per-tournament Redis mutex.
 *
 * Purpose: Serialize all bracket mutations for a given tournament. The bracket
 * engine (bracketService.ts) works by rebuilding state from the DB then
 * persisting it back (read-modify-write). Without a mutex, two concurrent
 * result reports for the same tournament both snapshot the same state; the last
 * persist silently wins and one result is lost.
 *
 * Implementation: SET … NX PX (Redis atomic conditional set) with a unique UUID
 * token per holder. Release is a Lua CAS (compare-and-delete): only the holder
 * that acquired the lock may delete it, so an expired lock that was taken over
 * by another worker is never accidentally released by the original holder.
 *
 * Timeouts:
 *   LOCK_TTL_MS        (10 s) — backstop TTL; a crashed holder cannot block
 *                               forever. Set well above the longest expected
 *                               DB round-trip.
 *   ACQUIRE_TIMEOUT_MS  (5 s) — maximum wait before giving up; callers receive
 *                               an Error if the bracket is still locked after
 *                               this window (e.g. pathological DB slowness).
 *   RETRY_DELAY_MS     (50 ms + 0–25 ms jitter) — polling interval between
 *                               acquire attempts. Low enough to feel snappy;
 *                               jitter reduces convoy effects under concurrent load.
 *
 * Key exports:
 *   withTournamentLock   — preferred entry point; acquires, runs fn, always releases.
 *   acquireTournamentLock / releaseTournamentLock — low-level pair for callers
 *                          that need explicit control (avoid if possible).
 *
 * Invariants:
 *   - The lock is NOT reentrant. Acquiring it twice on the same tournament
 *     from the same async call chain will block until ACQUIRE_TIMEOUT_MS then
 *     throw. Compose operations using the *Unlocked variants in bracketService
 *     rather than nesting withTournamentLock calls.
 *   - All three bracket mutation entry points (startTournament,
 *     reportTournamentResult, dqTournamentEntry, sweepNoShows) hold this lock.
 */
import { randomUUID } from "node:crypto";
import { redis } from "./redis";

// Per-tournament mutex on Redis (reuses the shared ioredis client from
// lib/redis.ts). Bracket mutations rebuild engine state from the DB and
// persist it back (read-modify-write), so concurrent reports against the
// same tournament must be serialized or the last write silently wins.
//
//   SET lock:tournament:<id> <token> NX PX 10000
//
// The token guards release: only the holder that acquired the lock may
// delete it (compare-and-delete via Lua), so an expired lock taken over
// by another worker is never released by the original holder.

const LOCK_TTL_MS = 10_000;
const ACQUIRE_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 50;

const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

function lockKey(tournamentId: string): string {
  return `lock:tournament:${tournamentId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire the per-tournament mutex.
 * @param tournamentId - the tournament to lock.
 * @returns The holder token (an opaque UUID); pass this to releaseTournamentLock.
 * @throws {Error} if the lock cannot be acquired within ACQUIRE_TIMEOUT_MS (5 s).
 *
 * Retries every ~50 ms with ±12 ms jitter until the deadline or success.
 * Prefer withTournamentLock over calling this directly.
 */
export async function acquireTournamentLock(tournamentId: string): Promise<string> {
  const token = randomUUID();
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    const ok = await redis.set(lockKey(tournamentId), token, "PX", LOCK_TTL_MS, "NX");
    if (ok === "OK") return token;
    if (Date.now() >= deadline) {
      throw new Error(
        `tournament ${tournamentId} is busy — could not acquire lock within ${ACQUIRE_TIMEOUT_MS}ms`
      );
    }
    await sleep(RETRY_DELAY_MS + Math.floor(Math.random() * 25));
  }
}

/**
 * Release the per-tournament mutex.
 * @param tournamentId - the tournament to unlock.
 * @param token        - the holder token returned by acquireTournamentLock.
 *
 * No-op if the token does not match the current lock holder (i.e. the TTL
 * already expired and another worker took over). Safe to call even after an
 * expiry — it will not accidentally release another holder's lock.
 */
export async function releaseTournamentLock(tournamentId: string, token: string): Promise<void> {
  await redis.eval(RELEASE_LUA, 1, lockKey(tournamentId), token);
}

/**
 * Run `fn` while holding the per-tournament mutex; always releases the lock
 * in a finally block, even when `fn` throws.
 * @param tournamentId - the tournament to lock.
 * @param fn           - async work to perform under the lock.
 * @returns The resolved value of `fn`.
 * @throws {Error} if the lock cannot be acquired, or re-throws any error from `fn`.
 *
 * NOT reentrant — see module invariants above.
 */
export async function withTournamentLock<T>(
  tournamentId: string,
  fn: () => Promise<T>
): Promise<T> {
  const token = await acquireTournamentLock(tournamentId);
  try {
    return await fn();
  } finally {
    await releaseTournamentLock(tournamentId, token);
  }
}
