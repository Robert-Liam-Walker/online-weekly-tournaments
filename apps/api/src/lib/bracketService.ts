import {
  DEBracket,
  generateDoubleElim,
  getPlacements,
  getReadyMatches,
  isComplete,
  reportResult,
} from "@foxtrot/shared";
import { prisma } from "./prisma";
import { isPresent } from "./presence";
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
  return withTournamentLock(tournamentId, () =>
    dqTournamentEntryUnlocked(tournamentId, userId)
  );
}

/**
 * DQ internals without the mutex — composed by callers that already hold it
 * (dqTournamentEntry, sweepNoShows). The lock is not reentrant, so acquiring
 * it twice on the same tournament would deadlock until the acquire timeout.
 */
async function dqTournamentEntryUnlocked(
  tournamentId: string,
  userId: string
): Promise<{ complete: boolean; forfeits: number }> {
  await prisma.tournamentEntry.update({
    where: { tournamentId_userId: { tournamentId, userId } },
    data: { dqAt: new Date() },
  });
  const tournament = await prisma.tournament.findUniqueOrThrow({
    where: { id: tournamentId },
  });
  if (tournament.status !== "ACTIVE") return { complete: false, forfeits: 0 };
  return sweepDqForfeits(tournamentId);
}

/** Subset of a TournamentMatch row that the no-show decision depends on */
export interface NoShowMatchState {
  player1Id: string | null;
  player2Id: string | null;
  winnerId: string | null;
  readyAt: Date | null;
}

/**
 * Decide which players of a single match must be DQ'd for a no-show.
 * Pure — unit tested. Decision matrix:
 *   - match not genuinely ready (missing player / decided / no readyAt) → none
 *   - ready for less than timeoutMinutes → none (not overdue yet)
 *   - both present → none (they're trying — leave the match to the TO)
 *   - exactly one present → DQ the absent player
 *   - neither present → DQ both (the forfeit cascade resolves the bracket)
 * Already-DQ'd entries are never DQ'd again.
 */
export function decideNoShowDqs(
  match: NoShowMatchState,
  presence: { player1: boolean; player2: boolean },
  alreadyDqd: ReadonlySet<string>,
  timeoutMinutes: number,
  now: Date
): string[] {
  if (!match.player1Id || !match.player2Id || match.winnerId != null) return [];
  if (match.readyAt == null) return [];
  if (now.getTime() - match.readyAt.getTime() < timeoutMinutes * 60_000) return [];
  const absent: string[] = [];
  if (!presence.player1) absent.push(match.player1Id);
  if (!presence.player2) absent.push(match.player2Id);
  return absent.filter((id) => !alreadyDqd.has(id));
}

export interface NoShowSweepResult {
  /** userIds disqualified by this sweep */
  dqd: string[];
  /** matches forfeited by the resulting DQ cascades */
  forfeits: number;
  /** tournament reached COMPLETED during this sweep */
  complete: boolean;
}

/**
 * Auto-DQ no-shows: for every ready match (both players, no winner) whose
 * readyAt is older than timeoutMinutes, check lobby presence (lib/presence —
 * refreshed by the game client's GET /:id/ready polling) and DQ the absent
 * player(s) per decideNoShowDqs. Runs under the per-tournament mutex and
 * composes the unlocked DQ internals, so each DQ's forfeit cascade can
 * advance — or complete — the bracket. No-op unless the tournament is ACTIVE
 * or when timeoutMinutes <= 0 (disabled).
 *
 * Decisions are made against a snapshot taken at sweep start: a match that
 * becomes ready mid-sweep gets a fresh readyAt stamp and therefore a fresh
 * timeout window. DQs keep applying after completion (dqAt still stamps) so
 * every decided no-show is recorded even when an earlier cascade finishes
 * the tournament.
 */
export async function sweepNoShows(
  tournamentId: string,
  timeoutMinutes: number
): Promise<NoShowSweepResult> {
  const result: NoShowSweepResult = { dqd: [], forfeits: 0, complete: false };
  if (timeoutMinutes <= 0) return result;

  return withTournamentLock(tournamentId, async () => {
    const tournament = await prisma.tournament.findUnique({ where: { id: tournamentId } });
    if (!tournament || tournament.status !== "ACTIVE") return result;

    // Ready matches as persisted by persistEngine: both players known, no
    // winner. readyAt is stamped the moment a match becomes playable.
    const matches = await prisma.tournamentMatch.findMany({
      where: {
        tournamentId,
        winnerId: null,
        player1Id: { not: null },
        player2Id: { not: null },
      },
      orderBy: [{ round: "asc" }, { matchNumber: "asc" }],
    });
    if (matches.length === 0) return result;

    const dqdEntries = await prisma.tournamentEntry.findMany({
      where: { tournamentId, dqAt: { not: null } },
      select: { userId: true },
    });
    const alreadyDqd = new Set(dqdEntries.map((e) => e.userId));

    const now = new Date();
    const toDq = new Set<string>();
    for (const m of matches) {
      const [player1, player2] = await Promise.all([
        isPresent(tournamentId, m.player1Id!),
        isPresent(tournamentId, m.player2Id!),
      ]);
      for (const userId of decideNoShowDqs(m, { player1, player2 }, alreadyDqd, timeoutMinutes, now)) {
        toDq.add(userId);
      }
    }

    for (const userId of toDq) {
      const dq = await dqTournamentEntryUnlocked(tournamentId, userId);
      result.dqd.push(userId);
      result.forfeits += dq.forfeits;
      if (dq.complete) result.complete = true;
    }
    return result;
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
