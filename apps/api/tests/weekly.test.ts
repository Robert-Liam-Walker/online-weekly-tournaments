import { describe, expect, it } from "vitest";
import {
  REGIONS,
  nextWeeklyAt,
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

describe("nextWeeklyAt — Friday 20:00 series", () => {
  // June 2026 Fridays (NA East): Jun 5, 12, 19, 26. 8pm EDT == 00:00 UTC next day.

  it("returns the upcoming Friday from a mid-week day", () => {
    // 2026-06-22 is a Monday, 10:00 EDT == 14:00 UTC.
    const now = new Date("2026-06-22T14:00:00.000Z");
    expect(nextWeeklyAt(NAE, now).toISOString()).toBe("2026-06-27T00:00:00.000Z"); // 8pm EDT Jun 26
  });

  it("returns today when it is Friday and 20:00 local has not passed", () => {
    // 2026-06-26 (Friday) 10:00 EDT == 14:00 UTC.
    const now = new Date("2026-06-26T14:00:00.000Z");
    expect(nextWeeklyAt(NAE, now).toISOString()).toBe("2026-06-27T00:00:00.000Z");
  });

  it("rolls to next Friday once Friday 20:00 local has passed", () => {
    // 2026-06-26 21:00 EDT == 2026-06-27 01:00 UTC.
    const now = new Date("2026-06-27T01:00:00.000Z");
    expect(nextWeeklyAt(NAE, now).toISOString()).toBe("2026-07-04T00:00:00.000Z"); // 8pm EDT Jul 3
  });

  it("is strictly future at exactly Friday 20:00 local", () => {
    const friday8pm = new Date("2026-06-27T00:00:00.000Z"); // 8pm EDT Jun 26 exactly
    expect(nextWeeklyAt(NAE, friday8pm).toISOString()).toBe("2026-07-04T00:00:00.000Z");
  });

  it("finds Friday from the day after (Saturday)", () => {
    // 2026-06-20 is a Saturday, 10:00 EDT == 14:00 UTC. Next Friday is Jun 26.
    const now = new Date("2026-06-20T14:00:00.000Z");
    expect(nextWeeklyAt(NAE, now).toISOString()).toBe("2026-06-27T00:00:00.000Z");
  });

  it("regions resolve their own Friday-local 20:00 instant", () => {
    const now = new Date("2026-06-22T14:00:00.000Z"); // Monday
    expect(nextWeeklyAt(EU, now).toISOString()).toBe("2026-06-26T18:00:00.000Z"); // 8pm CEST Jun 26
    expect(nextWeeklyAt(NAW, now).toISOString()).toBe("2026-06-27T03:00:00.000Z"); // 8pm PDT Jun 26
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
