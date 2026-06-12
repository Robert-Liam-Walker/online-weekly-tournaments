import "dotenv/config"; // load apps/api/.env when run standalone (run from apps/api/)
// No-show auto-DQ smoke test, run directly against the dev database
// (same pattern as scripts/smoke-integrity.ts):
//   npx -w apps/api tsx scripts/smoke-noshow.ts
//
// Covers:
//   1. one player present, one absent past the timeout → absent player DQ'd,
//      match forfeited to the present player, bracket advances
//   2. fresh (not overdue) and both-present matches are left alone
//   3. nobody present anywhere → every overdue player DQ'd, forfeit cascade
//      completes the tournament with placements
//
// Requires the dev Redis (presence keys + tournament lock) and Postgres.

import { prisma } from "../src/lib/prisma";
import { isPresent, markPresent } from "../src/lib/presence";
import { startTournament, sweepNoShows } from "../src/lib/bracketService";

const TAG = "smoke-noshow";
const TIMEOUT_MINUTES = 10;

type U = { id: string; username: string };

function expect(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
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
        },
      })
    );
  }
  return users;
}

async function makeActiveTournament(scenario: string, users: U[]): Promise<string> {
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
  const started = await startTournament(tournament.id);
  expect(started.started, `start failed: ${started.reason}`);
  return tournament.id;
}

async function backdateReadyAt(tournamentId: string, matchKey: string, minutesAgo: number) {
  await prisma.tournamentMatch.update({
    where: { tournamentId_matchKey: { tournamentId, matchKey } },
    data: { readyAt: new Date(Date.now() - minutesAgo * 60_000) },
  });
}

async function readyRows(tournamentId: string) {
  return prisma.tournamentMatch.findMany({
    where: {
      tournamentId,
      winnerId: null,
      player1Id: { not: null },
      player2Id: { not: null },
    },
    orderBy: [{ round: "asc" }, { matchNumber: "asc" }],
  });
}

async function entryByUser(tournamentId: string, userId: string) {
  return prisma.tournamentEntry.findUniqueOrThrow({
    where: { tournamentId_userId: { tournamentId, userId } },
  });
}

// ---------------------------------------------------------------------------
// Scenario A: one present, one absent → absent DQ'd, bracket advances;
//             fresh and both-present matches untouched
// ---------------------------------------------------------------------------
async function scenarioA() {
  console.log("scenario A: one absent player past the timeout");
  const users = await makeUsers("a", 4);
  const tid = await makeActiveTournament("a", users);

  const ready = await readyRows(tid);
  expect(ready.length === 2, `expected 2 ready matches after start (got ${ready.length})`);
  const [m1, m2] = ready;
  const present = m1.player1Id!;
  const absent = m1.player2Id!;

  // presence plumbing sanity
  await markPresent(tid, present);
  expect(await isPresent(tid, present), "markPresent → isPresent true");
  expect(!(await isPresent(tid, absent)), "unmarked player reads absent");

  // m1 has been ready for 11 minutes; m2 is fresh
  await backdateReadyAt(tid, m1.matchKey, TIMEOUT_MINUTES + 1);

  const sweep = await sweepNoShows(tid, TIMEOUT_MINUTES);
  expect(
    JSON.stringify(sweep.dqd) === JSON.stringify([absent]),
    `exactly the absent player is DQ'd (got ${JSON.stringify(sweep.dqd)})`
  );
  expect(sweep.forfeits === 1, `one forfeit recorded (got ${sweep.forfeits})`);
  expect(!sweep.complete, "tournament not complete after a single round-1 forfeit");

  expect((await entryByUser(tid, absent)).dqAt != null, "absent player's entry has dqAt");
  expect((await entryByUser(tid, present)).dqAt == null, "present player is not DQ'd");

  const m1After = await prisma.tournamentMatch.findUniqueOrThrow({
    where: { tournamentId_matchKey: { tournamentId: tid, matchKey: m1.matchKey } },
  });
  expect(m1After.winnerId === present, "match forfeited to the present player");

  const m2After = await prisma.tournamentMatch.findUniqueOrThrow({
    where: { tournamentId_matchKey: { tournamentId: tid, matchKey: m2.matchKey } },
  });
  expect(m2After.winnerId == null, "fresh (not overdue) match was left alone");
  expect((await entryByUser(tid, m2.player1Id!)).dqAt == null, "fresh match p1 not DQ'd");
  expect((await entryByUser(tid, m2.player2Id!)).dqAt == null, "fresh match p2 not DQ'd");

  const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tid } });
  expect(t.status === "ACTIVE", "tournament still ACTIVE");
  console.log("  ok: absent player DQ'd, match forfeited to the present player");

  // Second sweep: m2 now overdue but BOTH players present → leave to the TO
  await backdateReadyAt(tid, m2.matchKey, TIMEOUT_MINUTES + 1);
  await markPresent(tid, m2.player1Id!);
  await markPresent(tid, m2.player2Id!);
  const sweep2 = await sweepNoShows(tid, TIMEOUT_MINUTES);
  expect(sweep2.dqd.length === 0, `both-present overdue match DQ'd nobody (got ${sweep2.dqd})`);
  const m2Still = await prisma.tournamentMatch.findUniqueOrThrow({
    where: { tournamentId_matchKey: { tournamentId: tid, matchKey: m2.matchKey } },
  });
  expect(m2Still.winnerId == null, "both-present match still undecided");
  console.log("  ok: overdue match with both players present left to the TO");
}

// ---------------------------------------------------------------------------
// Scenario B: nobody present → both players of every overdue match DQ'd,
//             cascade completes the tournament with placements
// ---------------------------------------------------------------------------
async function scenarioB() {
  console.log("scenario B: nobody present — full no-show cascade");
  const users = await makeUsers("b", 4);
  const tid = await makeActiveTournament("b", users);

  for (const m of await readyRows(tid)) {
    await backdateReadyAt(tid, m.matchKey, TIMEOUT_MINUTES + 1);
  }

  const sweep = await sweepNoShows(tid, TIMEOUT_MINUTES);
  expect(
    sweep.dqd.length === users.length,
    `all ${users.length} no-shows DQ'd (got ${sweep.dqd.length})`
  );
  expect(sweep.complete, "forfeit cascade completed the tournament");

  const final = await prisma.tournament.findUniqueOrThrow({
    where: { id: tid },
    include: { entries: true, matches: true },
  });
  expect(final.status === "COMPLETED", `tournament COMPLETED (got ${final.status})`);
  expect(
    final.entries.every((e) => e.dqAt != null),
    "every entry carries a dqAt stamp"
  );
  expect(
    final.entries.every((e) => e.placement != null),
    "every entry received a placement"
  );
  expect(
    final.matches.every((m) => m.winnerId != null),
    "every persisted match was decided by the cascade"
  );
  console.log(
    "  ok: tournament completed with placements:",
    final.entries.map((e) => e.placement).sort((a, b) => a! - b!)
  );

  // Idempotence: nothing left for a follow-up sweep to do
  const again = await sweepNoShows(tid, TIMEOUT_MINUTES);
  expect(again.dqd.length === 0 && !again.complete, "follow-up sweep is a no-op");
  console.log("  ok: follow-up sweep is a no-op on the completed tournament");
}

async function main() {
  await cleanup();
  await scenarioA();
  await scenarioB();
  await cleanup();
  console.log("OK: all no-show scenarios passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
