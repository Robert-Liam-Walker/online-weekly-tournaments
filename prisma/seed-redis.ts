import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";

const prisma = new PrismaClient();
const redis = new Redis("redis://localhost:6379");

async function main() {
  const entries = await prisma.arenaEntry.findMany();
  for (const e of entries) {
    await redis.sadd("arena:entries", e.userId);
  }
  console.log(`Added ${entries.length} users to Redis arena`);
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });
