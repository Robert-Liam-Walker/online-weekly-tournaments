import { describe, expect, it } from "vitest";
import {
  applyAnnounce,
  ENDPOINT_FRESH_MS,
  RdvRecord,
  rdvMatchId,
  slotOf,
} from "../src/lib/rendezvous";
import { parseLanEndpoint } from "../src/udpRegistrar";

// Pure state-machine coverage: MINTED → P1/P2_ANNOUNCED → PAIRED →
// INVALIDATED, plus the review-mandated invariants — retryable PAIRED,
// last-writer-wins restarts, stale-endpoint regression, tombstone errors.

const T0 = 1_750_000_000_000;

function record(overrides: Partial<RdvRecord> = {}): RdvRecord {
  return {
    schemaVersion: 1,
    state: "MINTED",
    tournamentId: "tid1",
    matchKey: "W2-1",
    players: {
      p1: { userId: "u1", token: "a".repeat(32) },
      p2: { userId: "u2", token: "b".repeat(32) },
    },
    mintedAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

const announce1 = { nonce: "n1n1n1n1", ext: "203.0.113.1:41001", lan: "192.168.1.5:41001" };
const announce2 = { nonce: "n2n2n2n2", ext: "198.51.100.2:42002", lan: "192.168.1.6:42002" };

describe("rendezvous state machine", () => {
  it("first announce moves MINTED to the announcing slot's state and waits", () => {
    const { record: r1, response } = applyAnnounce(record(), "p1", announce1, T0 + 1000);
    expect(r1.state).toBe("P1_ANNOUNCED");
    expect(r1.updatedAt).toBe(T0 + 1000);
    expect(response).toEqual({ t: "wait", you: announce1.ext });
  });

  it("p2-first announce yields P2_ANNOUNCED (slot-based, not arbitrary)", () => {
    const { record: r1 } = applyAnnounce(record(), "p2", announce2, T0 + 1000);
    expect(r1.state).toBe("P2_ANNOUNCED");
  });

  it("both announced → PAIRED, each side gets the other's endpoints + identity", () => {
    const { record: r1 } = applyAnnounce(record(), "p1", announce1, T0 + 1000);
    const { record: r2, response: peer2 } = applyAnnounce(r1, "p2", announce2, T0 + 2000);
    expect(r2.state).toBe("PAIRED");
    expect(r2.pairedAt).toBe(T0 + 2000);
    expect(peer2).toMatchObject({
      t: "peer",
      you: announce2.ext,
      ext: announce1.ext,
      lan: announce1.lan,
      decider: false,
      idx: 1,
      matchId: rdvMatchId("tid1", "W2-1"),
      nonce: announce2.nonce,
      pnonce: announce1.nonce,
    });
    // p1 is the bracket's decider / index 0
    const { response: peer1 } = applyAnnounce(r2, "p1", announce1, T0 + 2500);
    expect(peer1).toMatchObject({ t: "peer", decider: true, idx: 0, ext: announce2.ext });
  });

  it("PAIRED is retryable: repeated announces keep answering peer", () => {
    let r = record();
    r = applyAnnounce(r, "p1", announce1, T0 + 1000).record;
    r = applyAnnounce(r, "p2", announce2, T0 + 2000).record;
    for (let i = 0; i < 3; i++) {
      const { record: next, response } = applyAnnounce(r, "p1", announce1, T0 + 3000 + i);
      expect(response.t).toBe("peer");
      expect(next.state).toBe("PAIRED");
      r = next;
    }
    // pairedAt stamps the first pairing only
    expect(r.pairedAt).toBe(T0 + 2000);
  });

  it("restart (new nonce + endpoint) is last-writer-wins; opponent learns the new endpoint", () => {
    let r = record();
    r = applyAnnounce(r, "p1", announce1, T0 + 1000).record;
    r = applyAnnounce(r, "p2", announce2, T0 + 2000).record;
    const restarted = { nonce: "n3n3n3n3", ext: "203.0.113.9:45000", lan: "192.168.1.5:45000" };
    r = applyAnnounce(r, "p1", restarted, T0 + 3000).record;
    expect(r.players.p1.nonce).toBe(restarted.nonce);
    const { response } = applyAnnounce(r, "p2", announce2, T0 + 3500);
    expect(response).toMatchObject({ t: "peer", ext: restarted.ext, pnonce: restarted.nonce });
  });

  it("a stale opponent endpoint regresses PAIRED to wait (no dead peer info)", () => {
    let r = record();
    r = applyAnnounce(r, "p1", announce1, T0 + 1000).record;
    r = applyAnnounce(r, "p2", announce2, T0 + 2000).record;
    expect(r.state).toBe("PAIRED");
    const later = T0 + 2000 + ENDPOINT_FRESH_MS + 1;
    const { record: r2, response } = applyAnnounce(r, "p2", announce2, later);
    expect(response.t).toBe("wait"); // p1 hasn't announced within the window
    expect(r2.state).toBe("P2_ANNOUNCED");
  });

  it("INVALIDATED tombstone answers err and never transitions", () => {
    const dead = record({ state: "INVALIDATED" });
    const { record: r1, response } = applyAnnounce(dead, "p1", announce1, T0 + 1000);
    expect(response).toEqual({ t: "err", code: "invalidated" });
    expect(r1.state).toBe("INVALIDATED");
  });

  it("slotOf maps userIds to bracket slots", () => {
    const r = record();
    expect(slotOf(r, "u1")).toBe("p1");
    expect(slotOf(r, "u2")).toBe("p2");
    expect(slotOf(r, "intruder")).toBeNull();
  });
});

describe("registrar lan validation", () => {
  it("accepts private IPv4 ranges", () => {
    expect(parseLanEndpoint("10.0.0.5:41000", false)).toEqual({ ip: "10.0.0.5", port: 41000 });
    expect(parseLanEndpoint("172.16.3.4:50000", false)).not.toBeNull();
    expect(parseLanEndpoint("172.31.255.1:1", false)).not.toBeNull();
    expect(parseLanEndpoint("192.168.1.6:42002", false)).not.toBeNull();
  });

  it("rejects public, malformed, and out-of-range values", () => {
    expect(parseLanEndpoint("8.8.8.8:53", false)).toBeNull();
    expect(parseLanEndpoint("172.32.0.1:1000", false)).toBeNull();
    expect(parseLanEndpoint("192.168.1.300:1000", false)).toBeNull();
    expect(parseLanEndpoint("192.168.1.5:0", false)).toBeNull();
    expect(parseLanEndpoint("192.168.1.5:70000", false)).toBeNull();
    expect(parseLanEndpoint("not-an-ip", false)).toBeNull();
    expect(parseLanEndpoint("::1:4000", false)).toBeNull();
  });

  it("loopback only outside production", () => {
    expect(parseLanEndpoint("127.0.0.1:41000", true)).toEqual({ ip: "127.0.0.1", port: 41000 });
    expect(parseLanEndpoint("127.0.0.1:41000", false)).toBeNull();
  });
});
