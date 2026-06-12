import "dotenv/config"; // load apps/api/.env when run standalone (run from apps/api/)
// Dev: a 16-player ACTIVE tournament with recognizable fake names so the
// in-game bracket layout can be eyeballed at full density. Idempotent-ish.
import { prisma } from "../src/lib/prisma";
import { startTournament } from "../src/lib/bracketService";

const NAME = "Sweet Sixteen Demo";
const FAKES = [
  "MANGO", "ZAIN", "CODY", "HBOX", "AMSA", "PLUP", "WIZZY", "AXE",
  "SFAT", "JMOOK", "LUCKY", "PPMD", "ARMADA", "MEWTWO", "LEFFEN",
];

async function main() {
  const me = await prisma.user.findUnique({
    where: { connectCode: process.env.SEED_CONNECT_CODE ?? "WEDE#971" },
  });
  if (!me) throw new Error("dev user missing - run seed-dev-events.ts first");

  const fakes = [];
  for (let i = 0; i < FAKES.length; i++) {
    const username = FAKES[i];
    let u = await prisma.user.findUnique({ where: { username } });
    if (!u) {
      u = await prisma.user.create({
        data: {
          username,
          email: `${username.toLowerCase()}@example.invalid`,
          passwordHash: "x",
          connectCode: `FK${String(i).padStart(2, "0")}#${100 + i}`,
        },
      });
    }
    fakes.push(u);
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
      description: "Dev: full 16 bracket for layout testing",
      scheduledAt: new Date(),
      format: "DOUBLE_ELIM",
      maxEntrants: 16,
      status: "REGISTRATION",
    },
  });
  for (const u of [me, ...fakes]) {
    await prisma.tournamentEntry.create({
      data: { tournamentId: t.id, userId: u.id, checkedInAt: new Date() },
    });
  }
  const res = await startTournament(t.id);
  console.log(`"${NAME}" (16 players) start:`, res);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
