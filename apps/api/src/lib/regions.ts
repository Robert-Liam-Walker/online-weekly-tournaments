// Regions: single source of truth for display names and IANA timezones.
// The Region enum values mirror prisma/schema.prisma.

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

/** Weekly start hour, in each region's local wall-clock time. */
export const WEEKLY_LOCAL_HOUR = 20;

/** Day of week the weekly series runs (0=Sunday .. 5=Friday .. 6=Saturday). */
export const WEEKLY_DOW = 5; // Friday

// ---------------------------------------------------------------------------
// Zero-dependency, DST-correct timezone math via Intl.
//
// wallClockUtcMs(instant, tz): re-reads `instant` as the tz's wall clock and
// returns that wall clock encoded as a UTC ms value. The difference to the
// real instant is the tz's UTC offset at that moment — which is exactly what
// we need to invert "wall clock -> instant" without a tz database dep.
// ---------------------------------------------------------------------------

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

/** The tz's local calendar date (y/m/d) at `instant`. */
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
 * The next WEEKLY_DOW (Friday) at WEEKLY_LOCAL_HOUR:00 in the region that is
 * strictly in the future relative to `now`: this Friday if it hasn't happened
 * yet, else next Friday. DST-correct.
 *
 * The region-local day of week is read off the local calendar date — weekday
 * is a property of the calendar date, so Date.UTC(y, m-1, d).getUTCDay() is
 * the region-local weekday regardless of the tz's offset.
 */
export function nextWeeklyAt(region: RegionInfo, now: Date = new Date()): Date {
  const { y, m, d } = localDateParts(now, region.tz);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  let offset = (WEEKLY_DOW - dow + 7) % 7; // 0 when today is already Friday
  // Two passes at most: this Friday, then (if 8pm already passed) next Friday.
  for (let i = 0; i < 2; i++) {
    // Advance the local calendar date by `offset` days; Date.UTC normalizes
    // month/year overflow. Noon avoids any DST edge ambiguity in the readback.
    const base = new Date(Date.UTC(y, m - 1, d + offset, 12));
    const bd = localDateParts(base, "UTC");
    const candidate = utcInstantForWallClock(region.tz, bd.y, bd.m, bd.d, WEEKLY_LOCAL_HOUR);
    if (candidate.getTime() > now.getTime()) return candidate;
    offset += 7;
  }
  // Unreachable: the second pass is always > now. Satisfy the type checker.
  const bd = localDateParts(new Date(Date.UTC(y, m - 1, d + offset, 12)), "UTC");
  return utcInstantForWallClock(region.tz, bd.y, bd.m, bd.d, WEEKLY_LOCAL_HOUR);
}

/** Region-local "Jun 13"-style date label for an instant. */
export function regionDateLabel(instant: Date, tz: string): string {
  return instant.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
}
