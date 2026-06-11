// Tournament-integrity smoke test, run directly against the dev database
// (same pattern as scripts/smoke-tournament.ts):
//   npx -w apps/api tsx scripts/smoke-integrity.ts
//
// Covers:
//   1. concurrent same-match reports → exactly one winner persisted (lock)
//   2. double-report rejected
//   3. report into a COMPLETED tournament rejected
//   4. DQ cascade mid-bracket → completes with correct placements
//   5. player DQ'd before the start is excluded from the bracket

import { prisma } from "../src/lib/prisma";
import {
  dqTournamentEntry,
  getReadyTournamentMatches,
  reportTournamentResult,
  startTournament,
} from "../src/lib/bracketService";

const TAG = "smoke-integrity";

type U = { id: string; username: string };

function expect(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function expectThrow(fn: () => Promise<unknown>, label: string): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    console.log(`  ok: ${label} rejected (${(err as Error).message})`);
    return err as Error;
  }
  throw new Error(`ASSERTION FAILED: ${label} should have thrown`);
}

async function cleanup() {
  const ts = await prisma.tournament.findMany({ where: { name: { startsWith: TAG } } });
  for (const t of ts) {
    await prisma.tournamentMatch.deleteMany({ where: { tournamentId: t.id } });
    await prisma.tournamentEntry.deleteMany({ where: { tournamentId: t.id } });
    await prisma.tournament.delete({ where: { id: t.id } });
  }
  await prisma.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
}

async function makeUsers(scenario: string, n: number): Promise<U[]> {
  const users: U[] = [];
  for (let i = 1; i <= n; i++) {
    users.push(
      await prisma.user.create({
        data: {
          username: `${TAG}-${scenario}-p${i}`,
          email: `${TAG}-${scenario}-p${i}@example.invalid`,
          passwordHash: "x",
          connectCode: `IN${scenario.slice(0, 1).toUpperCase()}${i}#${i}`,
        },
      })
    );
  }
  return users;
}

async function makeTournament(scenario: string, users: U[]) {
  const tournament = await prisma.tournament.create({
    data: {
      name: `${TAG} ${scenario}`,
      scheduledAt: new Date(),
      format: "DOUBLE_ELIM",
      maxEntrants: users.length,
      status: "REGISTRATION",
    },
  });
  for (const u of users) {
    await prisma.tournamentEntry.create({
      data: { tournamentId: tournament.id, userId: u.id, checkedInAt: new Date() },
    });
  }
  return tournament;
}

/** Play out the bracket, lower seed (array index) always winning */
async function playOutFavorites(tournamentId: string, seedOf: Map<string, number>) {
  for (let wave = 0; wave < 64; wave++) {
    const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    if (t.status === "COMPLETED") return;
    const ready = await getReadyTournamentMatches(tournamentId);
    if (ready.length === 0) throw new Error("deadlock: ACTIVE but no ready matches");
    for (const m of ready) {
      const winner =
        seedOf.get(m.player1.id)! < seedOf.get(m.player2.id)! ? m.player1.id : m.player2.id;
      try {
        await reportTournamentResult(tournamentId, m.matchKey, winner);
      } catch (err) {
        // Only tolerated when a DQ sweep inside an earlier report of this
        // wave already resolved the match; anything else is a real failure.
        const row = await prisma.tournamentMatch.findUnique({
          where: { tournamentId_matchKey: { tournamentId, matchKey: m.matchKey } },
        });
        if (!row?.winnerId) throw err;
      }
    }
  }
  throw new Error("bracket did not complete in 64 waves");
}

// ---------------------------------------------------------------------------
// Scenario A: concurrency + double report + report-into-completed (4 players)
// ---------------------------------------------------------------------------
async function scenarioA() {
  console.log("scenario A: concurrent reports, double report, report into COMPLETED");
  const users = await makeUsers("a", 4);
  const t = await makeTournament("a", users);
  const seedOf = new Map(users.map((u, i) => [u.id, i + 1]));

  const started = await startTournament(t.id);
  expect(started.started, `start failed: ${started.reason}`);

  const ready = await getReadyTournamentMatches(t.id);
  const w11 = ready.find((m) => m.matchKey === "W1-1");
  expect(!!w11, "W1-1 is ready after start");
  expect(w11!.readyAt != null, "ready match exposes a readyAt timestamp");

  // 1. Concurrent same-match reports: exactly one may win
  const [r1, r2] = await Promise.allSettled([
    reportTournamentResult(t.id, "W1-1", w11!.player1.id),
    reportTournamentResult(t.id, "W1-1", w11!.player2.id),
  ]);
  const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
  expect(
    fulfilled.length === 1,
    `exactly one concurrent report must win (got ${fulfilled.length} fulfilled)`
  );
  const row = await prisma.tournamentMatch.findUniqueOrThrow({
    where: { tournamentId_matchKey: { tournamentId: t.id, matchKey: "W1-1" } },
  });
  const expectedWinner = r1.status === "fulfilled" ? w11!.player1.id : w11!.player2.id;
  expect(row.winnerId === expectedWinner, "persisted winner matches the successful report");
  console.log("  ok: concurrent same-match reports → exactly one winner persisted");

  // 2. Double report rejected
  await expectThrow(
    () => reportTournamentResult(t.id, "W1-1", w11!.player1.id),
    "double report of W1-1"
  );
  const rowAfter = await prisma.tournamentMatch.findUniqueOrThrow({
    where: { tournamentId_matchKey: { tournamentId: t.id, matchKey: "W1-1" } },
  });
  expect(rowAfter.winnerId === expectedWinner, "double report did not change the winner");

  // 3. Report into COMPLETED rejected
  await playOutFavorites(t.id, seedOf);
  const done = await prisma.tournament.findUniqueOrThrow({ where: { id: t.id } });
  expect(done.status === "COMPLETED", "scenario A tournament completed");
  await expectThrow(
    () => reportTournamentResult(t.id, "GF", users[0].id),
    "report into COMPLETED tournament"
  );
}

// ---------------------------------------------------------------------------
// Scenario B: DQ cascade mid-bracket (8 players, DQ seed 1 after winners R1)
// ---------------------------------------------------------------------------
async function scenarioB() {
  console.log("scenario B: mid-bracket DQ cascade");
  const users = await makeUsers("b", 8);
  const t = await makeTournament("b", users);
  const seedOf = new Map(users.map((u, i) => [u.id, i + 1]));
  const s = (n: number) => users[n - 1]; // seed n

  const started = await startTournament(t.id);
  expect(started.started, `start failed: ${started.reason}`);

  // Winners round 1, favorites win: W1-1 s1>s8, W1-2 s4>s5, W1-3 s2>s7, W1-4 s3>s6
  for (const m of await getReadyTournamentMatches(t.id)) {
    const winner =
      seedOf.get(m.player1.id)! < seedOf.get(m.player2.id)! ? m.player1.id : m.player2.id;
    await reportTournamentResult(t.id, m.matchKey, winner);
  }

  // DQ seed 1 (currently waiting in W2-1 vs seed 4)
  const dq = await dqTournamentEntry(t.id, s(1).id);
  expect(dq.forfeits === 1, `DQ cascade forfeits W2-1 immediately (got ${dq.forfeits})`);
  const w21 = await prisma.tournamentMatch.findUniqueOrThrow({
    where: { tournamentId_matchKey: { tournamentId: t.id, matchKey: "W2-1" } },
  });
  expect(w21.winnerId === s(4).id, "opponent (seed 4) won the forfeited W2-1");
  const dqEntry = await prisma.tournamentEntry.findUniqueOrThrow({
    where: { tournamentId_userId: { tournamentId: t.id, userId: s(1).id } },
  });
  expect(dqEntry.dqAt != null, "dqAt stamped on the entry");
  console.log("  ok: DQ forfeited the ready match to the opponent");

  // Play the rest out; the sweep must forfeit seed 1's losers-bracket match
  // (L2-2) the moment it becomes ready.
  await playOutFavorites(t.id, seedOf);

  const final = await prisma.tournament.findUniqueOrThrow({
    where: { id: t.id },
    include: { entries: true, matches: true },
  });
  expect(final.status === "COMPLETED", "scenario B tournament completed");

  const l22 = final.matches.find((m) => m.matchKey === "L2-2");
  expect(!!l22 && l22.winnerId === s(6).id, "seed 1's losers match was forfeited to seed 6");
  expect(
    final.matches.every((m) => m.winnerId !== s(1).id || m.matchKey === "W1-1"),
    "DQ'd player won nothing after the DQ (only their pre-DQ W1-1)"
  );

  // Hand-computed placements for this script: favorites win everywhere,
  // seed 1 DQ'd after winners R1 → 1:s2 2:s3 3:s4 4:s6 5:s1,s5 7:s7,s8
  const expected: Record<number, number> = { 1: 5, 2: 1, 3: 2, 4: 3, 5: 5, 6: 4, 7: 7, 8: 7 };
  for (const e of final.entries) {
    const seed = seedOf.get(e.userId)!;
    expect(
      e.placement === expected[seed],
      `seed ${seed} placement ${e.placement} (expected ${expected[seed]})`
    );
  }
  console.log("  ok: bracket completed with correct placements:",
    final.entries
      .map((e) => ({ seed: seedOf.get(e.userId)!, placement: e.placement }))
      .sort((a, b) => a.seed - b.seed));
}

// ---------------------------------------------------------------------------
// Scenario C: DQ before the start excludes the player from the bracket
// ---------------------------------------------------------------------------
async function scenarioC() {
  console.log("scenario C: DQ before start");
  const users = await makeUsers("c", 4);
  const t = await makeTournament("c", users);
  const seedOf = new Map(users.map((u, i) => [u.id, i + 1]));
  const dqUser = users[3];

  const dq = await dqTournamentEntry(t.id, dqUser.id);
  expect(dq.forfeits === 0, "pre-start DQ performs no forfeits");

  const started = await startTournament(t.id);
  expect(started.started, `start failed: ${started.reason}`);

  const matches = await prisma.tournamentMatch.findMany({ where: { tournamentId: t.id } });
  expect(
    matches.every((m) => m.player1Id !== dqUser.id && m.player2Id !== dqUser.id),
    "DQ'd-before-start player appears in no match"
  );
  const entries = await prisma.tournamentEntry.findMany({ where: { tournamentId: t.id } });
  const dqEntry = entries.find((e) => e.userId === dqUser.id)!;
  expect(dqEntry.seed === null, "DQ'd entry got no locked-in seed");
  expect(dqEntry.dqAt != null, "DQ'd entry keeps its dqAt stamp");
  const seeds = entries.filter((e) => e.userId !== dqUser.id).map((e) => e.seed).sort();
  expect(JSON.stringify(seeds) === JSON.stringify([1, 2, 3]), "remaining players seeded 1..3");
  console.log("  ok: DQ'd player excluded from bracket lock-in");

  await playOutFavorites(t.id, seedOf);
  const final = await prisma.tournament.findUniqueOrThrow({
    where: { id: t.id },
    include: { entries: true },
  });
  expect(final.status === "COMPLETED", "scenario C tournament completed");
  expect(
    final.entries.find((e) => e.userId === dqUser.id)!.placement === null,
    "DQ'd-before-start player has no placement"
  );
  expect(
    final.entries.find((e) => e.userId === users[0].id)!.placement === 1,
    "seed 1 wins the 3-player bracket"
  );
}

async function main() {
  await cleanup();
  await scenarioA();
  await scenarioB();
  await scenarioC();
  await cleanup();
  console.log("OK: all integrity scenarios passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
