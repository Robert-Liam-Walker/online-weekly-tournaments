import "dotenv/config"; // load apps/api/.env when run standalone (run from apps/api/)
// Dev: spin up an ACTIVE tournament where the dev user has a ready
// bracket match against a fake opponent. Idempotent-ish (recreates).
import { prisma } from "../src/lib/prisma";
import { startTournament } from "../src/lib/bracketService";

const NAME = "Live Bracket Demo";

async function main() {
  const me = await prisma.user.findUnique({
    where: { username: process.env.SEED_USERNAME ?? "robert" },
  });
  if (!me) throw new Error("dev user missing - run seed-dev-events.ts first");

  let opp = await prisma.user.findUnique({ where: { username: "BracketDemoFoe" } });
  if (!opp) {
    opp = await prisma.user.create({
      data: {
        username: "BracketDemoFoe",
        email: "demo-opponent@example.invalid",
        passwordHash: "x",
      },
    });
  }

  const old = await prisma.tournament.findFirst({ where: { name: NAME } });
  if (old) {
    await prisma.tournamentMatch.deleteMany({ where: { tournamentId: old.id } });
    await prisma.tournamentEntry.deleteMany({ where: { tournamentId: old.id } });
    await prisma.tournament.delete({ where: { id: old.id } });
  }

  const t = await prisma.tournament.create({
    data: {
      name: NAME,
      description: "Dev: live bracket with a ready match",
      scheduledAt: new Date(),
      format: "DOUBLE_ELIM",
      maxEntrants: 8,
      status: "REGISTRATION",
    },
  });
  for (const u of [me, opp]) {
    await prisma.tournamentEntry.create({
      data: { tournamentId: t.id, userId: u.id, checkedInAt: new Date() },
    });
  }
  const res = await startTournament(t.id);
  console.log(`"${NAME}" start:`, res);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
