import { describe, expect, it } from "vitest";
import {
  DEBracket,
  generateDoubleElim,
  getChampion,
  getPlacements,
  getReadyMatches,
  isComplete,
  reportResult,
} from "./bracket";

function players(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `p${i + 1}`);
}

/** Mulberry32 — deterministic PRNG so failures are reproducible from the seed */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function playOut(b: DEBracket, random: () => number): void {
  // 4x the theoretical max match count guards against deadlock loops
  for (let guard = 0; guard < b.size * 8 + 16; guard++) {
    if (isComplete(b)) return;
    const ready = getReadyMatches(b);
    expect(ready.length).toBeGreaterThan(0); // no deadlock before completion
    const m = ready[Math.floor(random() * ready.length)];
    reportResult(b, m.def.key, random() < 0.5 ? m.p1! : m.p2!);
  }
  throw new Error("bracket did not complete within the guard limit");
}

function lossCounts(b: DEBracket): Map<string, number> {
  const losses = new Map<string, number>();
  for (const m of b.matches.values()) {
    if (m.done && m.loserId) {
      losses.set(m.loserId, (losses.get(m.loserId) ?? 0) + 1);
    }
  }
  return losses;
}

describe("generateDoubleElim structure", () => {
  it("seeds winners round 1 in standard order for 8 players", () => {
    const b = generateDoubleElim(players(8));
    const pairs = [1, 2, 3, 4].map((j) => {
      const m = b.matches.get(`W1-${j}`)!;
      return [m.p1, m.p2];
    });
    expect(pairs).toEqual([
      ["p1", "p8"],
      ["p4", "p5"],
      ["p2", "p7"],
      ["p3", "p6"],
    ]);
  });

  it("auto-completes byes when entrants are not a power of two", () => {
    const b = generateDoubleElim(players(6)); // size 8, seeds 1 and 2 get byes
    expect(b.size).toBe(8);
    expect(b.matches.get("W1-1")!.done).toBe(true);
    expect(b.matches.get("W1-1")!.winnerId).toBe("p1");
    // Ready matches never include a bye slot
    for (const m of getReadyMatches(b)) {
      expect(m.p1).not.toBeNull();
      expect(m.p2).not.toBeNull();
    }
  });

  it("rejects duplicates and fields that cannot bracket", () => {
    expect(() => generateDoubleElim(["a"])).toThrow();
    expect(() => generateDoubleElim(["a", "a", "b"])).toThrow();
  });
});

describe("known 8-player path", () => {
  it("crowns seed 1 without a reset when higher seeds always win", () => {
    const b = generateDoubleElim(players(8));
    for (let guard = 0; guard < 64 && !isComplete(b); guard++) {
      for (const m of getReadyMatches(b)) {
        const [s1, s2] = [m.p1!, m.p2!].map((p) => parseInt(p.slice(1), 10));
        reportResult(b, m.def.key, s1 < s2 ? m.p1! : m.p2!);
      }
    }
    expect(isComplete(b)).toBe(true);
    expect(getChampion(b)).toBe("p1");
    expect(b.matches.get("GFR")!.cancelled).toBe(true);
    const placements = new Map(getPlacements(b).map((p) => [p.playerId, p.placement]));
    expect(placements.get("p1")).toBe(1);
    expect(placements.get("p2")).toBe(2);
    expect(placements.get("p3")).toBe(3);
    expect(placements.get("p4")).toBe(4);
    expect(placements.get("p7")).toBe(7);
    expect(placements.get("p8")).toBe(7);
  });

  it("plays the bracket reset when the losers-side finalist wins GF", () => {
    const b = generateDoubleElim(players(4));
    // p1 beats p4, p2 beats p3; W2: p1 beats p2; L1: p4 beats p3; L2: p2 beats p4
    reportResult(b, "W1-1", "p1");
    reportResult(b, "W1-2", "p2");
    reportResult(b, "W2-1", "p1");
    reportResult(b, "L1-1", "p4");
    reportResult(b, "L2-1", "p2");
    // GF: losers-side p2 beats p1 -> reset required
    reportResult(b, "GF", "p2");
    expect(isComplete(b)).toBe(false);
    const reset = b.matches.get("GFR")!;
    expect(reset.cancelled).toBe(false);
    expect([reset.p1, reset.p2].sort()).toEqual(["p1", "p2"]);
    reportResult(b, "GFR", "p1");
    expect(getChampion(b)).toBe("p1");
    // p2 placed 2nd despite winning GF; both finalists have exactly 2 losses
    const placements = new Map(getPlacements(b).map((p) => [p.playerId, p.placement]));
    expect(placements.get("p2")).toBe(2);
    expect(lossCounts(b).get("p1")).toBe(1);
    expect(lossCounts(b).get("p2")).toBe(2);
  });
});

describe("random simulations hold double-elim invariants", () => {
  const entrantCounts = [2, 3, 4, 5, 6, 8, 11, 16, 23, 32];
  for (const n of entrantCounts) {
    it(`${n} entrants, 50 simulations`, () => {
      for (let trial = 0; trial < 50; trial++) {
        const b = generateDoubleElim(players(n));
        playOut(b, rng(n * 1000 + trial));

        const champion = getChampion(b)!;
        expect(b.players).toContain(champion);

        // Champion lost at most once; everyone else lost exactly twice
        const losses = lossCounts(b);
        expect(losses.get(champion) ?? 0).toBeLessThanOrEqual(1);
        for (const p of b.players) {
          if (p !== champion) expect(losses.get(p)).toBe(2);
        }

        // Placements cover every real player exactly once, champion first
        const placements = getPlacements(b);
        expect(placements.map((p) => p.playerId).sort()).toEqual([...b.players].sort());
        expect(placements.find((p) => p.placement === 1)!.playerId).toBe(champion);
        const ranks = placements.map((p) => p.placement);
        expect(Math.min(...ranks)).toBe(1);
      }
    });
  }
});
