import Redis from "ioredis";

export const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

// Arena presence key helpers
export const ARENA_KEY = "arena:entries";

export async function getArenaUserIds(): Promise<string[]> {
  return redis.smembers(ARENA_KEY);
}

export async function addToArena(userId: string): Promise<void> {
  await redis.sadd(ARENA_KEY, userId);
}

export async function removeFromArena(userId: string): Promise<void> {
  await redis.srem(ARENA_KEY, userId);
}

export async function isInArena(userId: string): Promise<boolean> {
  return (await redis.sismember(ARENA_KEY, userId)) === 1;
}
