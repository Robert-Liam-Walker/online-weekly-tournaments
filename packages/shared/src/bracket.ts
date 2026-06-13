// Double-elimination bracket engine. Pure and synchronous — no database,
// no IO — so the API layer can persist however it likes and tests can
// simulate thousands of tournaments.
//
// == Match key semantics ==
// Match keys are stable, human-readable strings persisted in TournamentMatch.matchKey:
//   "W{round}-{n}"   — winners bracket (e.g. "W1-1", "W2-3")
//   "L{round}-{n}"   — losers bracket  (e.g. "L1-1", "L4-2")
//   "GF"             — grand final
//   "GFR"            — grand final bracket reset
// Keys are 1-indexed within their round. The round numbering for winners and
// losers is independent: W1 is winners round 1, L1 is losers round 1.
//
// == Seeding and byes ==
// Entrants are passed in seed order (index 0 = seed 1). The bracket pads
// to the next power of two (minimum 4) with bye slots. A bye is represented
// as p1 or p2 === null. Bye matches auto-complete in propagate() and cascade
// forward, so the engine is always in a consistent state after any mutation.
// The standard Challonge-style seed placement is used for W round 1:
//   size 8 → match order [1v8, 4v5, 2v7, 3v6]
//
// == Source of truth ==
// The bracket engine is pure in-memory state. The API layer (bracketService.ts)
// is responsible for persisting match results to the database and rebuilding
// the engine from those persisted results. The DB (TournamentMatch rows) is
// the source of truth; the engine is always derived by replaying results.
//
// == Grand final and bracket reset ==
// GF (grand final): winners-bracket finalist (GF p1) vs. losers-bracket
//   finalist (GF p2). If GF p1 wins, GFR is cancelled (no reset needed —
//   the winners finalist never lost). If GF p2 wins, GFR is played.
// GFR (grand final bracket reset): GF winner vs. GF loser. The player who
//   wins GFR is the champion. cancelResetIfDecided() sets GFR.cancelled when
//   GF p1 wins GF.
//
// == Key invariants ==
// - Every real player loses exactly twice before elimination (double-elim rule).
// - The champion has lost at most once (won the bracket from winners side or
//   came back through losers and won the reset).
// - propagate() is called after every mutation; it is safe to call multiple
//   times (idempotent convergence).
// - reportResult() validates that the match is ready (both players, not done)
//   and that the winner is one of the two players; it throws on violation.

export type SlotSource =
  | { type: "seed"; seed: number } // 1-indexed; seeds beyond entrant count are byes
  | { type: "winnerOf"; matchKey: string }
  | { type: "loserOf"; matchKey: string };

export type BracketSide = "W" | "L" | "GF" | "GFR";

export interface BracketMatchDef {
  key: string;
  side: BracketSide;
  round: number; // 1-indexed within side
  matchNumber: number; // 1-indexed within round
  p1: SlotSource;
  p2: SlotSource;
}

export interface MatchState {
  def: BracketMatchDef;
  // undefined = source not decided yet; null = bye
  p1: string | null | undefined;
  p2: string | null | undefined;
  done: boolean;
  winnerId: string | null; // null only for bye-vs-bye autocompletions
  loserId: string | null;
  cancelled: boolean; // GFR when the winners-side finalist wins GF
}

export interface DEBracket {
  size: number; // padded to power of two, minimum 4
  players: string[]; // seed order
  matches: Map<string, MatchState>;
}

export interface Placement {
  playerId: string;
  placement: number; // 1, 2, 3, 4, 5, 5, 7, 7, ... (ties share the tier rank)
}

/**
 * Standard bracket seed placement for a bracket of `size`.
 * Returns seed numbers (1-indexed) in match-slot order for W round 1.
 * e.g. size 8 → [1, 8, 4, 5, 2, 7, 3, 6] (1v8, 4v5, 2v7, 3v6).
 * Built by recursive mirroring: each pass doubles the array and inserts
 * the complement (mirror - seed) after each existing entry.
 */
function seedPositions(size: number): number[] {
  let arr = [1];
  while (arr.length < size) {
    const mirror = arr.length * 2 + 1;
    const next: number[] = [];
    for (const s of arr) next.push(s, mirror - s);
    arr = next;
  }
  return arr;
}

/** Smallest power of two >= n. */
function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Build the complete list of BracketMatchDefs for a double-elimination bracket
 * of `size` players (must be a power of two, minimum 4).
 *
 * Structure:
 *   - Winners rounds 1..k (k = log2(size)).
 *   - Losers round 1: W1 losers paired off.
 *   - For i = 1..(k-1):
 *       Major losers round 2i: LB survivors vs. new losers dropping from W(i+1).
 *         The winners-loser assignment reverses on odd i to delay rematches.
 *       Minor losers round 2i+1: LB survivors paired (omitted for the last i).
 *   - Grand final (GF): W finalist vs. L finalist.
 *   - Grand final reset (GFR): GF winner vs. GF loser.
 */
function buildDefs(size: number): BracketMatchDef[] {
  const k = Math.log2(size); // winners rounds
  const defs: BracketMatchDef[] = [];
  const def = (
    side: BracketSide,
    round: number,
    matchNumber: number,
    p1: SlotSource,
    p2: SlotSource
  ) => {
    const key =
      side === "GF" || side === "GFR" ? side : `${side}${round}-${matchNumber}`;
    defs.push({ key, side, round, matchNumber, p1, p2 });
  };

  // Winners round 1 from seed positions
  const pos = seedPositions(size);
  for (let j = 1; j <= size / 2; j++) {
    def(
      "W",
      1,
      j,
      { type: "seed", seed: pos[2 * j - 2] },
      { type: "seed", seed: pos[2 * j - 1] }
    );
  }
  // Winners rounds 2..k
  for (let r = 2; r <= k; r++) {
    for (let j = 1; j <= size / 2 ** r; j++) {
      def(
        "W",
        r,
        j,
        { type: "winnerOf", matchKey: `W${r - 1}-${2 * j - 1}` },
        { type: "winnerOf", matchKey: `W${r - 1}-${2 * j}` }
      );
    }
  }

  // Losers round 1: winners-round-1 losers paired off
  for (let j = 1; j <= size / 4; j++) {
    def(
      "L",
      1,
      j,
      { type: "loserOf", matchKey: `W1-${2 * j - 1}` },
      { type: "loserOf", matchKey: `W1-${2 * j}` }
    );
  }
  // Alternating "major" rounds (LB survivors vs new winners-side losers)
  // and "minor" rounds (LB survivors paired). Major rounds reverse the
  // winners-loser order on odd drops to delay rematches.
  for (let i = 1; i <= k - 1; i++) {
    const major = 2 * i;
    const count = size / 2 ** (i + 1);
    for (let j = 1; j <= count; j++) {
      const drop = i % 2 === 1 ? count + 1 - j : j;
      def(
        "L",
        major,
        j,
        { type: "winnerOf", matchKey: `L${major - 1}-${j}` },
        { type: "loserOf", matchKey: `W${i + 1}-${drop}` }
      );
    }
    if (i <= k - 2) {
      const minor = 2 * i + 1;
      for (let j = 1; j <= count / 2; j++) {
        def(
          "L",
          minor,
          j,
          { type: "winnerOf", matchKey: `L${major}-${2 * j - 1}` },
          { type: "winnerOf", matchKey: `L${major}-${2 * j}` }
        );
      }
    }
  }

  const lastLosersRound = 2 * k - 2;
  def(
    "GF",
    1,
    1,
    { type: "winnerOf", matchKey: `W${k}-1` },
    { type: "winnerOf", matchKey: `L${lastLosersRound}-1` }
  );
  // Reset participants resolve through GF itself
  def(
    "GFR",
    1,
    1,
    { type: "winnerOf", matchKey: "GF" },
    { type: "loserOf", matchKey: "GF" }
  );
  return defs;
}

/**
 * Resolve a SlotSource to a player ID (or null for bye, or undefined if not yet decided).
 * - seed: look up by index into b.players; seeds beyond player count are null (bye).
 * - winnerOf / loserOf: look up the referenced match; return undefined if not done.
 */
function resolveSource(b: DEBracket, s: SlotSource): string | null | undefined {
  if (s.type === "seed") {
    return s.seed <= b.players.length ? b.players[s.seed - 1] : null;
  }
  const m = b.matches.get(s.matchKey);
  if (!m || !m.done) return undefined;
  return s.type === "winnerOf" ? m.winnerId : m.loserId;
}

/**
 * Fill resolvable slots and auto-complete bye matches until nothing changes.
 * Iterates all matches repeatedly; each pass may unlock downstream matches.
 * Terminates when a full pass produces no changes (convergence).
 * Covers both single-bye (one real player, one bye) and bye-vs-bye cascades.
 */
function propagate(b: DEBracket): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of b.matches.values()) {
      if (m.done || m.cancelled) continue;
      if (m.p1 === undefined) {
        const v = resolveSource(b, m.def.p1);
        if (v !== undefined) {
          m.p1 = v;
          changed = true;
        }
      }
      if (m.p2 === undefined) {
        const v = resolveSource(b, m.def.p2);
        if (v !== undefined) {
          m.p2 = v;
          changed = true;
        }
      }
      // Bye auto-completion (covers bye-vs-bye cascades too)
      if (m.p1 !== undefined && m.p2 !== undefined && (m.p1 === null || m.p2 === null)) {
        m.done = true;
        m.winnerId = m.p1 ?? m.p2;
        m.loserId = null;
        if (m.def.side === "GF") cancelResetIfDecided(b, m);
        changed = true;
      }
    }
  }
}

/**
 * Cancel the bracket reset (GFR) if the winners-side finalist (GF p1) wins GF.
 * When p1 wins GF, they never lost a match — no reset is needed or played.
 * Called by propagate() on bye-auto-completes and by reportResult().
 */
function cancelResetIfDecided(b: DEBracket, gf: MatchState): void {
  // If the winners-side finalist (GF p1) wins, there is no bracket reset
  if (gf.winnerId !== null && gf.winnerId === gf.p1) {
    const reset = b.matches.get("GFR")!;
    reset.cancelled = true;
  }
}

/**
 * Generate a complete double-elimination bracket for the given players.
 * @param playersInSeedOrder - player IDs in seed order (index 0 = seed 1).
 *   Minimum 2 players; no duplicates.
 * @returns A fully initialized DEBracket with all matches and bye slots resolved.
 * @throws {Error} if fewer than 2 players or if there are duplicate player IDs.
 *
 * The bracket size is padded to the next power of two (minimum 4).
 * propagate() is called after initialization to auto-complete all bye matches
 * and cascade results forward.
 */
export function generateDoubleElim(playersInSeedOrder: string[]): DEBracket {
  if (playersInSeedOrder.length < 2) {
    throw new Error("double elimination needs at least 2 players");
  }
  if (new Set(playersInSeedOrder).size !== playersInSeedOrder.length) {
    throw new Error("duplicate player in seed list");
  }
  const size = Math.max(4, nextPowerOfTwo(playersInSeedOrder.length));
  const b: DEBracket = {
    size,
    players: [...playersInSeedOrder],
    matches: new Map(),
  };
  for (const def of buildDefs(size)) {
    b.matches.set(def.key, {
      def,
      p1: undefined,
      p2: undefined,
      done: false,
      winnerId: null,
      loserId: null,
      cancelled: false,
    });
  }
  propagate(b);
  return b;
}

/**
 * Return all matches currently playable: both p1 and p2 are real (non-null)
 * players, the match is not done, and it is not cancelled.
 * These are the matches the API exposes to players.
 */
export function getReadyMatches(b: DEBracket): MatchState[] {
  const ready: MatchState[] = [];
  for (const m of b.matches.values()) {
    if (!m.done && !m.cancelled && m.p1 != null && m.p2 != null) ready.push(m);
  }
  return ready;
}

/**
 * Record the result of a match and propagate consequences through the bracket.
 * @param b        - the bracket to mutate (in place).
 * @param matchKey - the match to record (must exist, be playable, and be ready).
 * @param winnerId - the winning player's ID (must be p1 or p2 of this match).
 * @throws {Error} if the match is unknown, not playable, not ready, or if
 *   winnerId is not one of the two players.
 *
 * After recording the result, propagate() is called to fill downstream slots
 * and auto-complete any newly-unlocked bye matches.
 */
export function reportResult(b: DEBracket, matchKey: string, winnerId: string): void {
  const m = b.matches.get(matchKey);
  if (!m) throw new Error(`unknown match ${matchKey}`);
  if (m.done || m.cancelled) throw new Error(`match ${matchKey} is not playable`);
  if (m.p1 == null || m.p2 == null) throw new Error(`match ${matchKey} is not ready`);
  if (winnerId !== m.p1 && winnerId !== m.p2) {
    throw new Error(`player ${winnerId} is not in match ${matchKey}`);
  }
  m.done = true;
  m.winnerId = winnerId;
  m.loserId = winnerId === m.p1 ? m.p2 : m.p1;
  if (m.def.side === "GF") cancelResetIfDecided(b, m);
  propagate(b);
}

/**
 * True when the bracket is complete: GF is done, and GFR is either done or
 * cancelled (cancelled means the winners finalist won GF and no reset is needed).
 */
export function isComplete(b: DEBracket): boolean {
  const gf = b.matches.get("GF")!;
  const reset = b.matches.get("GFR")!;
  return gf.done && (reset.cancelled || reset.done);
}

/**
 * Return the tournament champion (the final winner).
 * @returns The champion's player ID, or null if the bracket is not complete.
 *
 * Champion is the GFR winner if a reset was played, or the GF winner if the
 * reset was cancelled (winners finalist never lost).
 */
export function getChampion(b: DEBracket): string | null {
  if (!isComplete(b)) return null;
  const reset = b.matches.get("GFR")!;
  return reset.cancelled ? b.matches.get("GF")!.winnerId : reset.winnerId;
}

/**
 * Final standings, ties sharing a tier: 1, 2, 3, 4, then 5/5, 7/7, ...
 * Only real players appear (byes are skipped).
 *
 * @throws {Error} if the bracket is not complete.
 *
 * Placement algorithm:
 *   1st: champion (see getChampion).
 *   2nd: the other finalist (GF loser if no reset; GFR loser if reset played).
 *   3rd: loser of the last losers round (L{2k-2}-1, single match).
 *   4th: loser of the semi-final losers round (L{2k-3}, two matches → tie).
 *   5/5: losers of L{2k-4}, etc. Each losers round contributes one tier;
 *        ties within a round share the same rank.
 */
export function getPlacements(b: DEBracket): Placement[] {
  if (!isComplete(b)) throw new Error("bracket is not complete");
  const placements: Placement[] = [];
  const champion = getChampion(b)!;
  placements.push({ playerId: champion, placement: 1 });

  const gf = b.matches.get("GF")!;
  const reset = b.matches.get("GFR")!;
  const runnerUp = reset.cancelled ? gf.loserId : reset.loserId;
  if (runnerUp) placements.push({ playerId: runnerUp, placement: 2 });

  const k = Math.log2(b.size);
  let rank = 3;
  // Traverse losers rounds from last to first; each round is one placement tier.
  for (let r = 2 * k - 2; r >= 1; r--) {
    let matchCount = 0;
    for (const m of b.matches.values()) {
      if (m.def.side !== "L" || m.def.round !== r) continue;
      matchCount++;
      if (m.loserId) placements.push({ playerId: m.loserId, placement: rank });
    }
    rank += matchCount;
  }
  return placements;
}
