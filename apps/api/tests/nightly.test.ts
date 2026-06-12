import { describe, expect, it } from "vitest";
import {
  REGIONS,
  nextNightAt,
  utcInstantForWallClock,
  regionDateLabel,
} from "../src/lib/regions";

const EU = REGIONS.find((r) => r.code === "EU")!;
const NAE = REGIONS.find((r) => r.code === "NA_EAST")!;
const NAW = REGIONS.find((r) => r.code === "NA_WEST")!;

describe("utcInstantForWallClock — DST matrix", () => {
  // US 2026: spring forward Mar 8, fall back Nov 1.
  // EU 2026: spring forward Mar 29, fall back Oct 25.

  it("NA East: EST (UTC-5) before spring forward", () => {
    expect(utcInstantForWallClock("America/New_York", 2026, 3, 7, 20).toISOString()).toBe(
      "2026-03-08T01:00:00.000Z"
    );
  });

  it("NA East: EDT (UTC-4) on the spring-forward day", () => {
    expect(utcInstantForWallClock("America/New_York", 2026, 3, 8, 20).toISOString()).toBe(
      "2026-03-09T00:00:00.000Z"
    );
  });

  it("NA East: EDT before fall back, EST after", () => {
    expect(utcInstantForWallClock("America/New_York", 2026, 10, 31, 20).toISOString()).toBe(
      "2026-11-01T00:00:00.000Z"
    );
    expect(utcInstantForWallClock("America/New_York", 2026, 11, 1, 20).toISOString()).toBe(
      "2026-11-02T01:00:00.000Z"
    );
  });

  it("NA West: PST/PDT pair around spring forward", () => {
    expect(utcInstantForWallClock("America/Los_Angeles", 2026, 3, 7, 20).toISOString()).toBe(
      "2026-03-08T04:00:00.000Z"
    );
    expect(utcInstantForWallClock("America/Los_Angeles", 2026, 3, 8, 20).toISOString()).toBe(
      "2026-03-09T03:00:00.000Z"
    );
  });

  it("EU: CET (UTC+1) before its spring forward, CEST (UTC+2) after", () => {
    expect(utcInstantForWallClock("Europe/Berlin", 2026, 3, 28, 20).toISOString()).toBe(
      "2026-03-28T19:00:00.000Z"
    );
    expect(utcInstantForWallClock("Europe/Berlin", 2026, 3, 29, 20).toISOString()).toBe(
      "2026-03-29T18:00:00.000Z"
    );
  });

  it("EU: CEST before its fall back, CET after", () => {
    expect(utcInstantForWallClock("Europe/Berlin", 2026, 10, 24, 20).toISOString()).toBe(
      "2026-10-24T18:00:00.000Z"
    );
    expect(utcInstantForWallClock("Europe/Berlin", 2026, 10, 25, 20).toISOString()).toBe(
      "2026-10-25T19:00:00.000Z"
    );
  });
});

describe("nextNightAt", () => {
  it("returns tonight when 20:00 local has not passed", () => {
    // 2026-06-12 10:00 EDT == 14:00 UTC
    const now = new Date("2026-06-12T14:00:00.000Z");
    expect(nextNightAt(NAE, now).toISOString()).toBe("2026-06-13T00:00:00.000Z"); // 8pm EDT
  });

  it("rolls to tomorrow when 20:00 local has passed", () => {
    // 2026-06-12 21:00 EDT == 2026-06-13 01:00 UTC
    const now = new Date("2026-06-13T01:00:00.000Z");
    expect(nextNightAt(NAE, now).toISOString()).toBe("2026-06-14T00:00:00.000Z");
  });

  it("is strictly future at exactly 20:00 local", () => {
    const tonight = new Date("2026-06-13T00:00:00.000Z"); // 8pm EDT exactly
    expect(nextNightAt(NAE, tonight).toISOString()).toBe("2026-06-14T00:00:00.000Z");
  });

  it("regions disagree on calendar date near midnight boundaries", () => {
    // 2026-06-13 01:30 UTC: EU is already June 13 (03:30 CEST) while NA West
    // is still June 12 (18:30 PDT) — each region gets its own local night.
    const now = new Date("2026-06-13T01:30:00.000Z");
    expect(nextNightAt(EU, now).toISOString()).toBe("2026-06-13T18:00:00.000Z"); // 8pm CEST Jun 13
    expect(nextNightAt(NAW, now).toISOString()).toBe("2026-06-13T03:00:00.000Z"); // 8pm PDT Jun 12
  });
});

describe("regionDateLabel", () => {
  it("labels with the region-local date, not the UTC date", () => {
    // 8pm PDT on Jun 12 is Jun 13 in UTC — label must say Jun 12.
    const instant = new Date("2026-06-13T03:00:00.000Z");
    expect(regionDateLabel(instant, "America/Los_Angeles")).toBe("Jun 12");
    expect(regionDateLabel(instant, "Europe/Berlin")).toBe("Jun 13");
  });
});
