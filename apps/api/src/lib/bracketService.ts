import {
  DEBracket,
  generateDoubleElim,
  getPlacements,
  getReadyMatches,
  isComplete,
  reportResult,
} from "@foxtrot/shared";
import { prisma } from "./prisma";
import { withTournamentLock } from "./tournamentLock";

// Bridges the pure bracket engine and the database. The engine state is
// never stored directly: it is rebuilt from the seeded entry list and the
// recorded results, so TournamentMatch rows stay the single source of truth.
//
// Every mutation (start, report, DQ) is a rebuild→persist read-modify-write,
// so all of them run under the per-tournament Redis mutex (tournamentLock):
// without it, two concurrent reports of the same match both rebuild from the
// same snapshot and the last persist silently wins.

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

/**
 * readyAt bookkeeping for a persisted match: stamp `now` the first time a
 * match becomes playable (both players set, no winner, no prior stamp);
 * preserve any existing stamp otherwise. Pure — unit tested.
 */
export function nextReadyAt(
  existingReadyAt: Date | null | undefined,
  isReadyNow: boolean,
  now: Date
): Date | null {
  return existingReadyAt ?? (isReadyNow ? now : null);
}

/** Mirror the full engine state into TournamentMatch rows */
async function persistEngine(tournamentId: string, bracket: DEBracket): Promise<void> {
  const existing = await prisma.tournamentMatch.findMany({
    where: { tournamentId },
    select: { matchKey: true, readyAt: true },
  });
  const existingReadyAt = new Map(existing.map((m) => [m.matchKey, m.readyAt]));
  const now = new Date();

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
    const isReadyNow = !m.done && m.p1 != null && m.p2 != null && m.winnerId == null;
    const data = {
      round: m.def.round,
      matchNumber: m.def.matchNumber,
      player1Id: m.p1 ?? null,
      player2Id: m.p2 ?? null,
      winnerId: m.winnerId,
      readyAt: nextReadyAt(existingReadyAt.get(m.def.key), isReadyNow, now),
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
  return withTournamentLock(tournamentId, () => startTournamentUnlocked(tournamentId));
}

async function startTournamentUnlocked(
  tournamentId: string
): Promise<{ started: boolean; reason?: string }> {
  const tournament = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!tournament) throw new Error("tournament not found");
  if (tournament.status !== "REGISTRATION") {
    return { started: false, reason: `status is ${tournament.status}` };
  }

  // Disqualified entries (dqAt set before the start) never enter the bracket
  const checkedIn = await prisma.tournamentEntry.findMany({
    where: { tournamentId, checkedInAt: { not: null }, dqAt: null },
    orderBy: [{ seed: "asc" }, { createdAt: "asc" }],
  });
  if (checkedIn.length < 2) {
    await prisma.tournament.update({
      where: { id: tournamentId },
      data: { status: "CANCELED" },
    });
    return { started: false, reason: "fewer than 2 players checked in" };
  }

  // Lock in final seeds 1..n on the checked-in entries; clear any stale
  // pre-assigned seed on excluded entries (DQ'd / no-shows) so rebuildEngine
  // only ever sees the locked-in field.
  await prisma.$transaction([
    prisma.tournamentEntry.updateMany({
      where: { tournamentId, id: { notIn: checkedIn.map((e) => e.id) } },
      data: { seed: null },
    }),
    ...checkedIn.map((entry, i) =>
      prisma.tournamentEntry.update({ where: { id: entry.id }, data: { seed: i + 1 } })
    ),
  ]);

  const bracket = generateDoubleElim(checkedIn.map((e) => e.userId));
  await persistEngine(tournamentId, bracket);
  await prisma.tournament.update({
    where: { id: tournamentId },
    data: { status: "ACTIVE" },
  });
  return { started: true };
}

/** Rebuild, apply one result, persist; finalize placements when complete. No lock. */
async function applyResult(
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

/**
 * Forfeit every ready match involving a disqualified entry (the opponent is
 * reported as winner) until none remain. Runs after each recorded result so
 * a DQ'd player who later lands in a newly-ready match (e.g. dropping into
 * losers) is forfeited as the bracket progresses. Caller must hold the lock
 * and ensure the tournament is ACTIVE.
 */
async function sweepDqForfeits(
  tournamentId: string
): Promise<{ complete: boolean; forfeits: number }> {
  let forfeits = 0;
  for (;;) {
    const dqd = await prisma.tournamentEntry.findMany({
      where: { tournamentId, dqAt: { not: null } },
      select: { userId: true },
    });
    if (dqd.length === 0) return { complete: false, forfeits };
    const dqIds = new Set(dqd.map((e) => e.userId));

    const bracket = await rebuildEngine(tournamentId);
    const target = getReadyMatches(bracket).find(
      (m) => dqIds.has(m.p1!) || dqIds.has(m.p2!)
    );
    if (!target) return { complete: false, forfeits };

    // The opponent of the DQ'd player wins; if both are DQ'd, p2 advances
    // (deterministic) and is forfeited again downstream.
    const winner = dqIds.has(target.p1!) ? target.p2! : target.p1!;
    const result = await applyResult(tournamentId, target.def.key, winner);
    forfeits++;
    if (result.complete) return { complete: true, forfeits };
  }
}

/** Record a result and advance the bracket; completes the tournament when done */
export async function reportTournamentResult(
  tournamentId: string,
  matchKey: string,
  winnerId: string
): Promise<{ complete: boolean }> {
  return withTournamentLock(tournamentId, async () => {
    const result = await applyResult(tournamentId, matchKey, winnerId);
    if (result.complete) return result;
    // Any DQ'd entry surfaced into a now-ready match forfeits immediately
    const sweep = await sweepDqForfeits(tournamentId);
    return { complete: sweep.complete };
  });
}

/**
 * Disqualify an entry. Before the start (REGISTRATION) this only stamps
 * dqAt — startTournament excludes the entry from the bracket. Mid-bracket
 * (ACTIVE) it additionally forfeits every ready match involving the player,
 * looping until no ready match involves a DQ'd entry; this can complete the
 * tournament. The whole operation holds the per-tournament mutex.
 */
export async function dqTournamentEntry(
  tournamentId: string,
  userId: string
): Promise<{ complete: boolean; forfeits: number }> {
  return withTournamentLock(tournamentId, async () => {
    await prisma.tournamentEntry.update({
      where: { tournamentId_userId: { tournamentId, userId } },
      data: { dqAt: new Date() },
    });
    const tournament = await prisma.tournament.findUniqueOrThrow({
      where: { id: tournamentId },
    });
    if (tournament.status !== "ACTIVE") return { complete: false, forfeits: 0 };
    return sweepDqForfeits(tournamentId);
  });
}

/** Matches ready to be played (both players known, no winner yet) */
export async function getReadyTournamentMatches(tournamentId: string) {
  const bracket = await rebuildEngine(tournamentId);
  const ready = getReadyMatches(bracket);

  const playerIds = [...new Set(ready.flatMap((m) => [m.p1!, m.p2!]))];
  const [users, rows] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: playerIds } },
      select: { id: true, username: true, connectCode: true },
    }),
    prisma.tournamentMatch.findMany({
      where: { tournamentId, matchKey: { in: ready.map((m) => m.def.key) } },
      select: { matchKey: true, readyAt: true },
    }),
  ]);
  const byId = new Map(users.map((u) => [u.id, u]));
  const readyAtByKey = new Map(rows.map((r) => [r.matchKey, r.readyAt]));

  return ready.map((m) => ({
    matchKey: m.def.key,
    round: m.def.round,
    matchNumber: m.def.matchNumber,
    readyAt: readyAtByKey.get(m.def.key) ?? null,
    player1: byId.get(m.p1!) ?? { id: m.p1!, username: "unknown", connectCode: "" },
    player2: byId.get(m.p2!) ?? { id: m.p2!, username: "unknown", connectCode: "" },
  }));
}
