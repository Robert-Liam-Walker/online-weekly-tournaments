// Gate setup (CI/CD test stage): a fresh 2-player tournament, both checked in,
// started — so uitester vs foe is a ready match (with a rendezvous ticket) to
// play a Bo3 set. Used by scripts/pipeline/test.sh in the FoxTrotMelee repo.
import { prisma } from "../src/lib/prisma";
import { startTournament } from "../src/lib/bracketService";

async function main() {
  const ui = await prisma.user.findUnique({ where: { email: "uitester@local.test" } });
  const foe = await prisma.user.findUnique({ where: { email: "foe@local.test" } });
  if (!ui || !foe) throw new Error("users not found — register uitester@local.test and foe@local.test first");

  // Clean up any prior Gate Test so re-runs are deterministic.
  const old = await prisma.tournament.findMany({ where: { name: "Gate Test" } });
  for (const t of old) {
    await prisma.tournamentMatch.deleteMany({ where: { tournamentId: t.id } });
    await prisma.tournamentEntry.deleteMany({ where: { tournamentId: t.id } });
    await prisma.tournament.delete({ where: { id: t.id } });
  }

  const t = await prisma.tournament.create({
    data: {
      name: "Gate Test",
      description: "CI/CD test-stage ranked Bo3 gate",
      scheduledAt: new Date(),
      format: "DOUBLE_ELIM",
      seriesFormat: "BO3",
      maxEntrants: 4,
      entryFee: 0,
      status: "REGISTRATION",
    },
  });
  // uitester first (seed 1), foe second (seed 2) — they meet in W2-1.
  await prisma.tournamentEntry.create({ data: { tournamentId: t.id, userId: ui.id, checkedInAt: new Date() } });
  await prisma.tournamentEntry.create({ data: { tournamentId: t.id, userId: foe.id, checkedInAt: new Date() } });

  const res = await startTournament(t.id);
  console.log("start:", JSON.stringify(res));

  const matches = await prisma.tournamentMatch.findMany({
    where: { tournamentId: t.id, winnerId: null, player1Id: { not: null }, player2Id: { not: null } },
  });
  console.log("Gate Test tournament id:", t.id);
  for (const m of matches) {
    const p1 = m.player1Id === ui.id ? "uitester" : "foe";
    const p2 = m.player2Id === ui.id ? "uitester" : "foe";
    console.log("  READY MATCH:", m.matchKey, "=", p1, "vs", p2);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
