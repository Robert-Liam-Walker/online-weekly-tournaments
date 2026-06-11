import {
  DEBracket,
  generateDoubleElim,
  getPlacements,
  getReadyMatches,
  isComplete,
  reportResult,
} from "@foxtrot/shared";
import { prisma } from "./prisma";

// Bridges the pure bracket engine and the database. The engine state is
// never stored directly: it is rebuilt from the seeded entry list and the
// recorded results, so TournamentMatch rows stay the single source of truth.

const CHECKIN_OPENS_MINUTES_BEFORE = 30;

export function checkinWindowOpen(scheduledAt: Date, now = new Date()): boolean {
  return now.getTime() >= scheduledAt.getTime() - CHECKIN_OPENS_MINUTES_BEFORE * 60_000;
}

async function loadSeededPlayerIds(tournamentId: string): Promise<string[]> {
  const entries = await prisma.tournamentEntry.findMany({
    where: { tournamentId, checkedInAt: { not: null }, seed: { not: null } },
    orderBy: { seed: "asc" },
  });
  return entries.map((e) => e.userId);
}

/** Rebuild the engine from seeds + recorded results (replay until stable) */
async function rebuildEngine(tournamentId: string): Promise<DEBracket> {
  const playerIds = await loadSeededPlayerIds(tournamentId);
  const bracket = generateDoubleElim(playerIds);

  const recorded = await prisma.tournamentMatch.findMany({
    where: { tournamentId, winnerId: { not: null } },
  });
  // Only replay real results — bye completions re-derive inside the engine
  const pending = recorded.filter((m) => m.player1Id && m.player2Id);
  let progress = true;
  while (progress && pending.length > 0) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const row = pending[i];
      const m = bracket.matches.get(row.matchKey);
      if (m && !m.done && m.p1 != null && m.p2 != null) {
        reportResult(bracket, row.matchKey, row.winnerId!);
        pending.splice(i, 1);
        progress = true;
      }
    }
  }
  if (pending.length > 0) {
    throw new Error(
      `tournament ${tournamentId}: recorded results do not replay cleanly (${pending
        .map((m) => m.matchKey)
        .join(", ")})`
    );
  }
  return bracket;
}

/** Mirror the full engine state into TournamentMatch rows */
async function persistEngine(tournamentId: string, bracket: DEBracket): Promise<void> {
  const ops = [];
  for (const m of bracket.matches.values()) {
    if (m.cancelled) {
      ops.push(
        prisma.tournamentMatch.deleteMany({
          where: { tournamentId, matchKey: m.def.key },
        })
      );
      continue;
    }
    const data = {
      round: m.def.round,
      matchNumber: m.def.matchNumber,
      player1Id: m.p1 ?? null,
      player2Id: m.p2 ?? null,
      winnerId: m.winnerId,
    };
    ops.push(
      prisma.tournamentMatch.upsert({
        where: { tournamentId_matchKey: { tournamentId, matchKey: m.def.key } },
        create: { tournamentId, matchKey: m.def.key, ...data },
        update: data,
      })
    );
  }
  await prisma.$transaction(ops);
}

/**
 * Close check-in and start the tournament: seed checked-in players (by
 * pre-assigned seed, then registration order), generate the bracket, and
 * flip status. Cancels if fewer than 2 players checked in.
 */
export async function startTournament(tournamentId: string): Promise<{ started: boolean; reason?: string }> {
  const tournament = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!tournament) throw new Error("tournament not found");
  if (tournament.status !== "REGISTRATION") {
    return { started: false, reason: `status is ${tournament.status}` };
  }

  const checkedIn = await prisma.tournamentEntry.findMany({
    where: { tournamentId, checkedInAt: { not: null } },
    orderBy: [{ seed: "asc" }, { createdAt: "asc" }],
  });
  if (checkedIn.length < 2) {
    await prisma.tournament.update({
      where: { id: tournamentId },
      data: { status: "CANCELED" },
    });
    return { started: false, reason: "fewer than 2 players checked in" };
  }

  // Lock in final seeds 1..n on the checked-in entries
  await prisma.$transaction(
    checkedIn.map((entry, i) =>
      prisma.tournamentEntry.update({ where: { id: entry.id }, data: { seed: i + 1 } })
    )
  );

  const bracket = generateDoubleElim(checkedIn.map((e) => e.userId));
  await persistEngine(tournamentId, bracket);
  await prisma.tournament.update({
    where: { id: tournamentId },
    data: { status: "ACTIVE" },
  });
  return { started: true };
}

/** Record a result and advance the bracket; completes the tournament when done */
export async function reportTournamentResult(
  tournamentId: string,
  matchKey: string,
  winnerId: string
): Promise<{ complete: boolean }> {
  const bracket = await rebuildEngine(tournamentId);
  reportResult(bracket, matchKey, winnerId); // validates readiness + participant
  await persistEngine(tournamentId, bracket);

  if (!isComplete(bracket)) return { complete: false };

  const placements = getPlacements(bracket);
  await prisma.$transaction([
    ...placements.map((p) =>
      prisma.tournamentEntry.updateMany({
        where: { tournamentId, userId: p.playerId },
        data: { placement: p.placement },
      })
    ),
    prisma.tournament.update({
      where: { id: tournamentId },
      data: { status: "COMPLETED" },
    }),
  ]);
  return { complete: true };
}

/** Matches ready to be played (both players known, no winner yet) */
export async function getReadyTournamentMatches(tournamentId: string) {
  const bracket = await rebuildEngine(tournamentId);
  const ready = getReadyMatches(bracket);

  const playerIds = [...new Set(ready.flatMap((m) => [m.p1!, m.p2!]))];
  const users = await prisma.user.findMany({
    where: { id: { in: playerIds } },
    select: { id: true, username: true, connectCode: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  return ready.map((m) => ({
    matchKey: m.def.key,
    round: m.def.round,
    matchNumber: m.def.matchNumber,
    player1: byId.get(m.p1!) ?? { id: m.p1!, username: "unknown", connectCode: "" },
    player2: byId.get(m.p2!) ?? { id: m.p2!, username: "unknown", connectCode: "" },
  }));
}
