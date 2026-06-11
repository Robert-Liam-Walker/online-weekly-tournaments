import { afterAll, describe, expect, it } from "vitest";
import { decideNoShowDqs, NoShowMatchState } from "../src/lib/bracketService";
import { readyTimeoutMinutes } from "../src/lib/scheduleTournaments";
import { redis } from "../src/lib/redis";

// bracketService → tournamentLock/presence pulls in the shared ioredis
// client, which connects eagerly; disconnect so the worker can exit cleanly.
afterAll(() => {
  redis.disconnect();
});

const TIMEOUT_MINUTES = 10;
const now = new Date("2026-06-11T20:00:00Z");
const overdue = new Date(now.getTime() - 11 * 60_000); // ready 11 min ago
const recent = new Date(now.getTime() - 9 * 60_000); // ready 9 min ago

const none: ReadonlySet<string> = new Set();

function match(overrides: Partial<NoShowMatchState> = {}): NoShowMatchState {
  return { player1Id: "p1", player2Id: "p2", winnerId: null, readyAt: overdue, ...overrides };
}

function decide(
  m: NoShowMatchState,
  presence: { player1: boolean; player2: boolean },
  alreadyDqd: ReadonlySet<string> = none
) {
  return decideNoShowDqs(m, presence, alreadyDqd, TIMEOUT_MINUTES, now);
}

describe("decideNoShowDqs (no-show decision matrix)", () => {
  it("DQs nobody while both players are present (leave the match to the TO)", () => {
    expect(decide(match(), { player1: true, player2: true })).toEqual([]);
  });

  it("DQs exactly the absent player when one is present", () => {
    expect(decide(match(), { player1: true, player2: false })).toEqual(["p2"]);
    expect(decide(match(), { player1: false, player2: true })).toEqual(["p1"]);
  });

  it("DQs both players when neither is present", () => {
    expect(decide(match(), { player1: false, player2: false })).toEqual(["p1", "p2"]);
  });

  it("DQs nobody while the match is not yet overdue", () => {
    expect(decide(match({ readyAt: recent }), { player1: false, player2: false })).toEqual([]);
    expect(decide(match({ readyAt: now }), { player1: false, player2: false })).toEqual([]);
  });

  it("becomes overdue exactly at the timeout boundary", () => {
    const boundary = new Date(now.getTime() - TIMEOUT_MINUTES * 60_000);
    expect(decide(match({ readyAt: boundary }), { player1: false, player2: false })).toEqual([
      "p1",
      "p2",
    ]);
  });

  it("never DQs an already-DQ'd entry", () => {
    expect(decide(match(), { player1: false, player2: false }, new Set(["p2"]))).toEqual(["p1"]);
    expect(decide(match(), { player1: true, player2: false }, new Set(["p2"]))).toEqual([]);
    expect(decide(match(), { player1: false, player2: false }, new Set(["p1", "p2"]))).toEqual([]);
  });

  it("ignores matches that are already decided", () => {
    expect(decide(match({ winnerId: "p1" }), { player1: false, player2: false })).toEqual([]);
  });

  it("ignores matches that do not have both players yet", () => {
    expect(decide(match({ player2Id: null }), { player1: false, player2: false })).toEqual([]);
    expect(decide(match({ player1Id: null }), { player1: false, player2: false })).toEqual([]);
  });

  it("ignores matches with no readyAt stamp (defensive)", () => {
    expect(decide(match({ readyAt: null }), { player1: false, player2: false })).toEqual([]);
  });
});

describe("readyTimeoutMinutes (READY_TIMEOUT_MINUTES env)", () => {
  const original = process.env.READY_TIMEOUT_MINUTES;
  afterAll(() => {
    if (original === undefined) delete process.env.READY_TIMEOUT_MINUTES;
    else process.env.READY_TIMEOUT_MINUTES = original;
  });

  it("defaults to 10 when unset", () => {
    delete process.env.READY_TIMEOUT_MINUTES;
    expect(readyTimeoutMinutes()).toBe(10);
  });

  it("parses a custom timeout", () => {
    process.env.READY_TIMEOUT_MINUTES = "5";
    expect(readyTimeoutMinutes()).toBe(5);
  });

  it("treats 0 as disabled", () => {
    process.env.READY_TIMEOUT_MINUTES = "0";
    expect(readyTimeoutMinutes()).toBe(0);
  });

  it("falls back to the default on garbage or negative values", () => {
    process.env.READY_TIMEOUT_MINUTES = "soon";
    expect(readyTimeoutMinutes()).toBe(10);
    process.env.READY_TIMEOUT_MINUTES = "-3";
    expect(readyTimeoutMinutes()).toBe(10);
  });
});
