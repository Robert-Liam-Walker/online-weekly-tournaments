import { afterAll, describe, expect, it } from "vitest";
import { checkinWindowOpen, nextReadyAt } from "../src/lib/bracketService";
import { paidEventsEnabled } from "../src/routes/tournaments";
import { redis } from "../src/lib/redis";

// bracketService → tournamentLock pulls in the shared ioredis client, which
// connects eagerly; disconnect so the worker can exit cleanly.
afterAll(() => {
  redis.disconnect();
});

describe("checkinWindowOpen", () => {
  const scheduled = new Date("2026-06-11T20:00:00Z");

  it("is closed more than 30 minutes before the scheduled time", () => {
    expect(checkinWindowOpen(scheduled, new Date("2026-06-11T19:29:59Z"))).toBe(false);
  });

  it("opens exactly 30 minutes before", () => {
    expect(checkinWindowOpen(scheduled, new Date("2026-06-11T19:30:00Z"))).toBe(true);
  });

  it("stays open at and after the scheduled time", () => {
    expect(checkinWindowOpen(scheduled, new Date("2026-06-11T20:00:00Z"))).toBe(true);
    expect(checkinWindowOpen(scheduled, new Date("2026-06-11T21:00:00Z"))).toBe(true);
  });
});

describe("nextReadyAt (persistEngine readyAt bookkeeping)", () => {
  const now = new Date("2026-06-11T20:00:00Z");
  const earlier = new Date("2026-06-11T19:00:00Z");

  it("stamps now when a match first becomes ready", () => {
    expect(nextReadyAt(null, true, now)).toBe(now);
    expect(nextReadyAt(undefined, true, now)).toBe(now); // row not persisted yet
  });

  it("preserves an existing stamp while the match stays ready", () => {
    expect(nextReadyAt(earlier, true, now)).toBe(earlier);
  });

  it("preserves the stamp after the match is decided (no longer ready)", () => {
    expect(nextReadyAt(earlier, false, now)).toBe(earlier);
  });

  it("stays null while the match is not yet ready", () => {
    expect(nextReadyAt(null, false, now)).toBeNull();
    expect(nextReadyAt(undefined, false, now)).toBeNull();
  });
});

describe("paidEventsEnabled", () => {
  const original = process.env.PAID_EVENTS_ENABLED;
  afterAll(() => {
    if (original === undefined) delete process.env.PAID_EVENTS_ENABLED;
    else process.env.PAID_EVENTS_ENABLED = original;
  });

  it("is disabled when the flag is unset", () => {
    delete process.env.PAID_EVENTS_ENABLED;
    expect(paidEventsEnabled()).toBe(false);
  });

  it("requires the exact string 'true'", () => {
    process.env.PAID_EVENTS_ENABLED = "1";
    expect(paidEventsEnabled()).toBe(false);
    process.env.PAID_EVENTS_ENABLED = "TRUE";
    expect(paidEventsEnabled()).toBe(false);
    process.env.PAID_EVENTS_ENABLED = "false";
    expect(paidEventsEnabled()).toBe(false);
  });

  it("is enabled when PAID_EVENTS_ENABLED=true", () => {
    process.env.PAID_EVENTS_ENABLED = "true";
    expect(paidEventsEnabled()).toBe(true);
  });
});
