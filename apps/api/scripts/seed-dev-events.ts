import "dotenv/config"; // load apps/api/.env when run standalone (run from apps/api/)
// Dev seeding: Robert's account + near-term test events so the in-game
// browser has data. Idempotent.
import { prisma } from "../src/lib/prisma";

async function main() {
  const username = process.env.SEED_USERNAME ?? "robert";
  let user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        username,
        email: "robert.liam.walker@gmail.com",
        passwordHash: "dev-placeholder-not-a-real-hash",
      },
    });
    console.log(`created user ${user.username}`);
  } else {
    console.log(`user ${user.username} already exists`);
  }

  const events = [
    { name: "Friday Night FoxTrot", minutesOut: 20, maxEntrants: 8 },
    { name: "Late Bracket Test", minutesOut: 180, maxEntrants: 8 },
  ];
  for (const e of events) {
    const existing = await prisma.tournament.findFirst({ where: { name: e.name } });
    if (existing) {
      console.log(`event "${e.name}" already exists`);
      continue;
    }
    await prisma.tournament.create({
      data: {
        name: e.name,
        description: "Dev test event",
        scheduledAt: new Date(Date.now() + e.minutesOut * 60_000),
        format: "DOUBLE_ELIM",
        seriesFormat: "BO3",
        maxEntrants: e.maxEntrants,
        status: "REGISTRATION",
      },
    });
    console.log(`created event "${e.name}" (+${e.minutesOut} min)`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
