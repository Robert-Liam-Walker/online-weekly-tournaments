// Double-elimination bracket engine. Pure and synchronous — no database,
// no IO — so the API layer can persist however it likes and tests can
// simulate thousands of tournaments.
//
// Match keys are stable strings the rest of the system can reference
// (TournamentMatch.matchKey): "W{round}-{n}" winners side, "L{round}-{n}"
// losers side, "GF" grand final, "GFR" grand final bracket reset.
//
// Entrants are passed in seed order (index 0 = seed 1). The bracket pads
// to the next power of two with byes; bye matches auto-complete and
// cascade, which also covers check-in no-shows.

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

/** Standard bracket seed placement: size 8 -> [1,8,4,5,2,7,3,6] */
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

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

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

function resolveSource(b: DEBracket, s: SlotSource): string | null | undefined {
  if (s.type === "seed") {
    return s.seed <= b.players.length ? b.players[s.seed - 1] : null;
  }
  const m = b.matches.get(s.matchKey);
  if (!m || !m.done) return undefined;
  return s.type === "winnerOf" ? m.winnerId : m.loserId;
}

/** Fill resolvable slots and auto-complete bye matches until nothing changes */
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

function cancelResetIfDecided(b: DEBracket, gf: MatchState): void {
  // If the winners-side finalist (GF p1) wins, there is no bracket reset
  if (gf.winnerId !== null && gf.winnerId === gf.p1) {
    const reset = b.matches.get("GFR")!;
    reset.cancelled = true;
  }
}

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

/** Matches with two real players that are ready to be played */
export function getReadyMatches(b: DEBracket): MatchState[] {
  const ready: MatchState[] = [];
  for (const m of b.matches.values()) {
    if (!m.done && !m.cancelled && m.p1 != null && m.p2 != null) ready.push(m);
  }
  return ready;
}

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

export function isComplete(b: DEBracket): boolean {
  const gf = b.matches.get("GF")!;
  const reset = b.matches.get("GFR")!;
  return gf.done && (reset.cancelled || reset.done);
}

export function getChampion(b: DEBracket): string | null {
  if (!isComplete(b)) return null;
  const reset = b.matches.get("GFR")!;
  return reset.cancelled ? b.matches.get("GF")!.winnerId : reset.winnerId;
}

/**
 * Final standings, ties sharing a tier: 1, 2, 3, 4, then 5/5, 7/7, ...
 * Only real players appear (byes are skipped).
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
