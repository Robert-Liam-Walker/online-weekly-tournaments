/**
 * regions.ts — Region definitions and DST-correct timezone math.
 *
 * Purpose: Single source of truth for the three nightly-regional regions
 * (EU / NA East / NA West) — their display labels, IANA timezone strings, and
 * the UTC instant computation for a given wall-clock time in that region.
 * Used by scheduleTournaments.ts to create each night's tournament at
 * exactly 20:00 region-local time regardless of DST transitions.
 *
 * IMPORTANT — DUPLICATION NOTE: This file is duplicated at
 *   apps/web/src/lib/regions.ts
 * so the web client can perform the same timezone math without an API round-
 * trip. Any change here must be mirrored there. The two files should ideally
 * be consolidated into packages/shared — tracked as a TODO but not fixed here
 * to stay within the no-behavior-change constraint of this pass.
 *
 * DST-correct math (zero external dependencies):
 *   Node's `Intl.DateTimeFormat` exposes the tz's wall clock at any instant
 *   without a bundled timezone database. utcInstantForWallClock uses a
 *   two-pass convergence to convert "y-m-d hour:00 in tz" → UTC:
 *     1. Assume UTC offset = 0, get a first-guess UTC instant.
 *     2. Measure the real offset at that instant; subtract to correct.
 *     3. Repeat once — sufficient because DST offsets are step functions;
 *        the second iteration always lands on the post-transition offset.
 *   For a non-existent wall time (spring-forward gap) this resolves to the
 *   instant one hour later — the sensible behaviour for an event start.
 *
 * Key exports:
 *   REGIONS            — ordered array of RegionInfo; iterate to create nightly
 *                        events for all three regions.
 *   NIGHTLY_LOCAL_HOUR — wall-clock hour (20) at which nightly events start.
 *   nextNightAt        — the next 20:00-local instant strictly in the future.
 *   utcInstantForWallClock — general wall-clock → UTC converter.
 *   localDateParts     — tz-local calendar date for an instant.
 *   regionDateLabel    — short human label ("Jun 13") for UIs and event names.
 *
 * Invariants:
 *   - RegionCode values ("EU", "NA_EAST", "NA_WEST") must match the Region
 *     enum in prisma/schema.prisma; the scheduler writes these directly to the
 *     DB region column.
 *   - Formatter instances are cached per tz to avoid re-creating Intl objects
 *     on every tick (called once per minute per region in production).
 */

// Nightly-regional regions: single source of truth for display names and
// IANA timezones. The Region enum values mirror prisma/schema.prisma.

export type RegionCode = "EU" | "NA_EAST" | "NA_WEST";

export interface RegionInfo {
  code: RegionCode;
  /** Human label used in event names and UIs. */
  label: string;
  /** IANA timezone anchoring "8pm local" for the region. */
  tz: string;
}

export const REGIONS: RegionInfo[] = [
  { code: "EU", label: "EU", tz: "Europe/Berlin" },
  { code: "NA_EAST", label: "NA East", tz: "America/New_York" },
  { code: "NA_WEST", label: "NA West", tz: "America/Los_Angeles" },
];

/** Nightly start hour, in each region's local wall-clock time. */
export const NIGHTLY_LOCAL_HOUR = 20;

// ---------------------------------------------------------------------------
// Zero-dependency, DST-correct timezone math via Intl.
//
// wallClockUtcMs(instant, tz): re-reads `instant` as the tz's wall clock and
// returns that wall clock encoded as a UTC ms value. The difference to the
// real instant is the tz's UTC offset at that moment — which is exactly what
// we need to invert "wall clock -> instant" without a tz database dep.
// ---------------------------------------------------------------------------

/** Cached Intl.DateTimeFormat instances, keyed by IANA tz string. */
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

/** The tz's wall-clock reading of `instant`, encoded as Date.UTC ms. */
function wallClockUtcMs(instant: Date, tz: string): number {
  const parts = formatterFor(tz).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  // Intl renders midnight as hour "24" in some environments — normalize.
  const hour = get("hour") % 24;
  return Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
}

/**
 * The tz's local calendar date (y/m/d) at `instant`.
 * @param instant - the UTC instant to project into the tz.
 * @param tz      - IANA timezone identifier (e.g. "America/New_York").
 * @returns       y (full year), m (1-12), d (1-31).
 */
export function localDateParts(instant: Date, tz: string): { y: number; m: number; d: number } {
  const parts = formatterFor(tz).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/**
 * The UTC instant at which the wall clock in `tz` reads y-m-d hour:00:00.
 *
 * Two-pass convergence: start from the naive UTC encoding of the wall time,
 * measure the tz offset at that guess, correct, and re-check once — which
 * converges across DST transitions (offset changes are step functions; the
 * second pass lands on the post-transition offset). For a wall time that
 * doesn't exist (spring-forward gap) this resolves to the instant one hour
 * later, which is the sane behavior for an event start.
 *
 * @param tz   - IANA timezone identifier.
 * @param y    - full year (e.g. 2026).
 * @param m    - month 1–12.
 * @param d    - day 1–31.
 * @param hour - wall-clock hour 0–23.
 * @returns The UTC Date for the requested wall-clock time in `tz`.
 */
export function utcInstantForWallClock(
  tz: string,
  y: number,
  m: number,
  d: number,
  hour: number
): Date {
  const targetWallUtcMs = Date.UTC(y, m - 1, d, hour, 0, 0, 0);
  let guess = targetWallUtcMs;
  for (let i = 0; i < 2; i++) {
    const offsetMs = wallClockUtcMs(new Date(guess), tz) - guess;
    guess = targetWallUtcMs - offsetMs;
  }
  return new Date(guess);
}

/**
 * The next NIGHTLY_LOCAL_HOUR:00 in the region that is strictly in the
 * future relative to `now`: tonight's if it hasn't happened yet, else
 * tomorrow's. DST-correct.
 *
 * @param region - one of the REGIONS entries.
 * @param now    - reference instant (defaults to Date.now()).
 * @returns The UTC Date of the next 20:00 local in the region.
 */
export function nextNightAt(region: RegionInfo, now: Date = new Date()): Date {
  const { y, m, d } = localDateParts(now, region.tz);
  let candidate = utcInstantForWallClock(region.tz, y, m, d, NIGHTLY_LOCAL_HOUR);
  if (candidate.getTime() <= now.getTime()) {
    // Tomorrow in region-local terms: advance the local calendar date by one
    // (Date.UTC normalizes month/year overflow).
    const next = new Date(Date.UTC(y, m - 1, d + 1, 12)); // noon avoids edge ambiguity
    const nd = localDateParts(next, "UTC");
    candidate = utcInstantForWallClock(region.tz, nd.y, nd.m, nd.d, NIGHTLY_LOCAL_HOUR);
  }
  return candidate;
}

/**
 * Region-local "Jun 13"-style date label for an instant.
 * Used in tournament name generation (e.g. "Randalls Nightly — EU — Jun 13").
 * @param instant - the UTC instant to label.
 * @param tz      - IANA timezone identifier.
 */
export function regionDateLabel(instant: Date, tz: string): string {
  return instant.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
}
