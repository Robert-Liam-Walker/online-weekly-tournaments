import "dotenv/config"; // load apps/api/.env when run standalone (run from apps/api/)
// End-to-end smoke test for the tournament bracket flow, run directly
// against the dev database:
//   npx -w apps/api tsx scripts/smoke-tournament.ts
// Creates 8 throwaway users + a tournament, checks everyone in, starts it,
// plays it out (higher seed always wins), verifies placements, cleans up.

import { prisma } from "../src/lib/prisma";
import {
  getReadyTournamentMatches,
  reportTournamentResult,
  startTournament,
} from "../src/lib/bracketService";

const TAG = "smoke-de8";

async function cleanup() {
  const t = await prisma.tournament.findFirst({ where: { name: TAG } });
  if (t) {
    await prisma.tournamentMatch.deleteMany({ where: { tournamentId: t.id } });
    await prisma.tournamentEntry.deleteMany({ where: { tournamentId: t.id } });
    await prisma.tournament.delete({ where: { id: t.id } });
  }
  await prisma.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
}

async function main() {
  await cleanup();

  const users = [];
  for (let i = 1; i <= 8; i++) {
    users.push(
      await prisma.user.create({
        data: {
          username: `${TAG}-p${i}`,
          email: `${TAG}-p${i}@example.invalid`,
          passwordHash: "x",
          connectCode: `SM${String(i).padStart(2, "0")}#${i}`,
        },
      })
    );
  }

  const tournament = await prisma.tournament.create({
    data: {
      name: TAG,
      scheduledAt: new Date(),
      format: "DOUBLE_ELIM",
      maxEntrants: 8,
      status: "REGISTRATION",
    },
  });

  // Register + check in all 8 (registration order = seed order here)
  for (const u of users) {
    await prisma.tournamentEntry.create({
      data: { tournamentId: tournament.id, userId: u.id, checkedInAt: new Date() },
    });
  }

  const started = await startTournament(tournament.id);
  if (!started.started) throw new Error(`start failed: ${started.reason}`);

  const seedOf = new Map(users.map((u, i) => [u.id, i + 1]));
  let rounds = 0;
  for (; rounds < 32; rounds++) {
    const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tournament.id } });
    if (t.status === "COMPLETED") break;
    const ready = await getReadyTournamentMatches(tournament.id);
    if (ready.length === 0) throw new Error("deadlock: ACTIVE but no ready matches");
    for (const m of ready) {
      const winner =
        seedOf.get(m.player1.id)! < seedOf.get(m.player2.id)! ? m.player1.id : m.player2.id;
      await reportTournamentResult(tournament.id, m.matchKey, winner);
    }
  }

  const final = await prisma.tournament.findUniqueOrThrow({
    where: { id: tournament.id },
    include: { entries: true, matches: true },
  });
  if (final.status !== "COMPLETED") throw new Error("tournament did not complete");

  const placements = final.entries
    .map((e) => ({ seed: seedOf.get(e.userId)!, placement: e.placement }))
    .sort((a, b) => a.seed - b.seed);
  console.log("placements by seed:", placements);

  const expect = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  };
  expect(placements[0].placement === 1, "seed 1 wins when favorites win out");
  expect(placements[1].placement === 2, "seed 2 places 2nd");
  expect(placements[2].placement === 3, "seed 3 places 3rd");
  expect(
    final.matches.every((m) => m.matchKey !== "GFR"),
    "no bracket reset row when winners-side finalist wins GF"
  );
  expect(final.matches.length === 14, `expected 14 match rows, got ${final.matches.length}`);

  console.log(`OK: completed in ${rounds} waves, ${final.matches.length} matches persisted`);
  await cleanup();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
