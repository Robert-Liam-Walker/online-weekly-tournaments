// Dev seeding: Robert's account (Slippi connect code) + near-term test
// events so the in-game browser has data. Idempotent.
import { prisma } from "../src/lib/prisma";

async function main() {
  const connectCode = process.env.SEED_CONNECT_CODE ?? "WEDE#971";
  let user = await prisma.user.findUnique({ where: { connectCode } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        username: "robert",
        email: "robert.liam.walker@gmail.com",
        passwordHash: "dev-placeholder-not-a-real-hash",
        connectCode,
      },
    });
    console.log(`created user ${user.username} (${connectCode})`);
  } else {
    console.log(`user ${user.username} (${connectCode}) already exists`);
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
