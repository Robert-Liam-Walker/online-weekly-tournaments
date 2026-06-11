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

/** Acquire the tournament mutex; resolves to the holder token. Retries for ~5s. */
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

/** Release the mutex only if we still hold it (token must match). */
export async function releaseTournamentLock(tournamentId: string, token: string): Promise<void> {
  await redis.eval(RELEASE_LUA, 1, lockKey(tournamentId), token);
}

/** Run fn while holding the per-tournament mutex. Not reentrant. */
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
