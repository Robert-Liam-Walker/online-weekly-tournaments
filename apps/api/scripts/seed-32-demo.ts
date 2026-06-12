// Seeds a 32-entrant ACTIVE demo tournament so the in-game bracket UI can
// be eyeballed at full capacity (the 32-cap release gate). Same direct-DB
// pattern as smoke-integrity.ts:
//   npx -w apps/api tsx scripts/seed-32-demo.ts
//
// Creates "Randalls 32 Demo" (NA_EAST), 32 fake-named checked-in entrants,
// starts the real bracket, and reports a spread of early results so the
// view shows decided, in-progress, and pending sets. Re-runnable: deletes
// any previous demo first. Prints the tournament id.

import { prisma } from "../src/lib/prisma";
import { reportTournamentResult, startTournament } from "../src/lib/bracketService";

const NAME = "Randalls 32 Demo";
const TAG = "demo32";

const FAKE_NAMES = [
  "CloudNine", "StadiumStorm", "RandallFan", "WhispyWinds", "PichuPower",
  "MarthMain", "FalcoLasers", "ShineSpike", "WaveDashWiz", "LCancelLord",
  "EddsMash", "TomatoKirby", "GreenGreens", "YoshiEgg", "DKPunch",
  "NessYoyo", "SamusCharge", "LinkBoomer", "ZeldaWarp", "GanonStomp",
  "MewtwoTail", "IceClimber", "PeachTurnip", "BowserFlame", "FoxTrotter",
  "JigglyRest", "DocPills", "YLinkBombs", "RoyFlare", "PikaThunder",
  "LuigiCyclone", "MrGameWatch",
];

async function main() {
  // Clean any previous demo (entries/matches/replays cascade via deleteMany)
  const old = await prisma.tournament.findFirst({ where: { name: NAME } });
  if (old) {
    await prisma.tournamentReplay.deleteMany({ where: { tournamentId: old.id } });
    await prisma.tournamentMatch.deleteMany({ where: { tournamentId: old.id } });
    await prisma.tournamentEntry.deleteMany({ where: { tournamentId: old.id } });
    await prisma.tournament.delete({ where: { id: old.id } });
    console.log("removed previous demo tournament");
  }

  const users: { id: string }[] = [];
  for (let i = 0; i < 32; i++) {
    const username = FAKE_NAMES[i];
    const user = await prisma.user.upsert({
      where: { email: `${TAG}-${i}@example.invalid` },
      update: {},
      create: {
        username: `${username}`,
        email: `${TAG}-${i}@example.invalid`,
        passwordHash: "x",
        connectCode: `DM${String(i).padStart(2, "0")}#${100 + i}`,
      },
    });
    users.push(user);
  }

  const t = await prisma.tournament.create({
    data: {
      name: NAME,
      description: "Seeded 32-man bracket for UI verification.",
      scheduledAt: new Date(),
      region: "NA_EAST",
      format: "DOUBLE_ELIM",
      seriesFormat: "BO3",
      maxEntrants: 32,
      entryFee: 0,
      status: "REGISTRATION",
    },
  });

  await prisma.tournamentEntry.createMany({
    data: users.map((u, i) => ({
      tournamentId: t.id,
      userId: u.id,
      seed: i + 1,
      checkedInAt: new Date(),
    })),
  });

  const started = await startTournament(t.id);
  if (!started.started) throw new Error(`start failed: ${started.reason}`);

  // Report a visual spread: all of W1, half of L1, a couple of W2 — leaves
  // plenty pending so the in-game view shows every set state.
  const reportSome = async (prefix: string, fraction: number) => {
    const matches = await prisma.tournamentMatch.findMany({
      where: { tournamentId: t.id, matchKey: { startsWith: prefix }, winnerId: null },
      orderBy: { matchKey: "asc" },
    });
    const count = Math.ceil(matches.length * fraction);
    for (const m of matches.slice(0, count)) {
      if (!m.player1Id || !m.player2Id) continue;
      // Lower entry id wins for determinism; alternate occasionally for variety
      const winner = m.matchKey.endsWith("3") ? m.player2Id : m.player1Id;
      await reportTournamentResult(t.id, m.matchKey, winner);
    }
  };

  await reportSome("W1-", 1.0);
  await reportSome("L1-", 0.5);
  await reportSome("W2-", 0.4);

  const decided = await prisma.tournamentMatch.count({
    where: { tournamentId: t.id, winnerId: { not: null } },
  });
  const total = await prisma.tournamentMatch.count({ where: { tournamentId: t.id } });
  console.log(`OK: "${NAME}" seeded — id=${t.id}, ${decided}/${total} sets decided, status ACTIVE`);
  console.log("In-game: event browser -> Randalls 32 Demo -> Y for the bracket view.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
