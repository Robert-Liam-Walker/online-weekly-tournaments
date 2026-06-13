/**
 * regions.ts — region-to-timezone mapping and time-display helpers.
 *
 * PURPOSE
 *   Provides typed region constants and formatting utilities used by the
 *   tournament listing UI to display start times in each region's local
 *   timezone alongside the viewer's own local time.
 *
 * DUPLICATION WARNING
 *   TODO(cleanup): This file duplicates apps/api/src/lib/regions.ts.
 *   The two must be kept in sync manually whenever region labels, timezones,
 *   or the TournamentRegion union type change. A shared package (e.g.
 *   packages/shared) would eliminate the duplication, but that refactor is
 *   out of scope here — do not merge without the API side.
 *
 * REGION MODEL
 *   The API is gaining a `region` field on tournaments ("EU" | "NA_EAST" |
 *   "NA_WEST"); older rows have no region at all. Always run values through
 *   `isKnownRegion` before mapping — unknown/missing regions fall into the
 *   generic "other tournaments" list.
 *
 * EXPORTS
 * ──────────────────────────────────────────────────────────────────────────
 *   TournamentRegion
 *     Union type for valid region codes: "EU" | "NA_EAST" | "NA_WEST".
 *
 *   REGIONS
 *     Map from TournamentRegion → { label: string; tz: IANA timezone string }.
 *     EU    → Europe/Berlin
 *     NA_EAST → America/New_York
 *     NA_WEST → America/Los_Angeles
 *
 *   REGION_ORDER
 *     Canonical display order for the nightly hero grid: EU, NA_EAST, NA_WEST.
 *
 *   isKnownRegion(value) → value is TournamentRegion
 *     Type guard; returns true when value is a string key of REGIONS.
 *
 *   regionDate(iso, region) → string
 *     Event date formatted in the region's timezone, e.g. "Fri, Jun 13".
 *
 *   regionTime(iso, region) → string
 *     Event time in the region's timezone with abbreviated tz name,
 *     e.g. "8:00 PM CEST".
 *
 *   viewerTime(iso, region) → string | null
 *     The same instant in the viewer's browser timezone, e.g. "2:00 PM your
 *     time". Returns null when the viewer's local time string matches the
 *     region's (nothing worth repeating). If the viewer's local date differs
 *     from the region's (e.g. EU 8 PM landing after midnight in Asia/Pacific)
 *     the weekday is prefixed: "Sat 4:00 AM your time".
 */

// Region helper for Randall's Nightly Tournaments.
//
// The API is gaining a `region` field on tournaments ("EU" | "NA_EAST" |
// "NA_WEST"); older rows have no region at all. Always run values through
// `isKnownRegion` before mapping — unknown/missing regions fall into the
// generic "other tournaments" list.

export type TournamentRegion = "EU" | "NA_EAST" | "NA_WEST";

export const REGIONS: Record<TournamentRegion, { label: string; tz: string }> = {
  EU: { label: "EU", tz: "Europe/Berlin" },
  NA_EAST: { label: "NA East", tz: "America/New_York" },
  NA_WEST: { label: "NA West", tz: "America/Los_Angeles" },
};

/** Display order for the nightly hero grid. */
export const REGION_ORDER: TournamentRegion[] = ["EU", "NA_EAST", "NA_WEST"];

/** Type guard: true when `value` is a recognized TournamentRegion code. */
export function isKnownRegion(value: unknown): value is TournamentRegion {
  return typeof value === "string" && value in REGIONS;
}

const TIME: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

function fmt(d: Date, opts: Intl.DateTimeFormatOptions) {
  // Locale intentionally left as the browser default per the timezone
  // display rule; only the timeZone is pinned.
  return new Intl.DateTimeFormat(undefined, opts).format(d);
}

/** Event date in the REGION's timezone, e.g. "Fri, Jun 13". */
export function regionDate(iso: string, region: TournamentRegion): string {
  return fmt(new Date(iso), {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: REGIONS[region].tz,
  });
}

/** Event time in the REGION's timezone with tz name, e.g. "8:00 PM CEST". */
export function regionTime(iso: string, region: TournamentRegion): string {
  return fmt(new Date(iso), {
    ...TIME,
    timeZone: REGIONS[region].tz,
    timeZoneName: "short",
  });
}

/**
 * The same instant on the viewer's clock, e.g. "2:00 PM your time" — or
 * null when the viewer's wall-clock time matches the region's (nothing
 * worth repeating). If the viewer's local DATE differs from the region's
 * (e.g. an EU 8 PM event lands after midnight in Asia/Pacific), the
 * viewer's weekday is prefixed: "Sat 4:00 AM your time".
 */
export function viewerTime(iso: string, region: TournamentRegion): string | null {
  const d = new Date(iso);
  const tz = REGIONS[region].tz;
  const local = fmt(d, TIME); // browser-default timezone
  if (local === fmt(d, { ...TIME, timeZone: tz })) return null;
  const dateOpts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const dayPrefix =
    fmt(d, dateOpts) !== fmt(d, { ...dateOpts, timeZone: tz })
      ? `${fmt(d, { weekday: "short" })} `
      : "";
  return `${dayPrefix}${local} your time`;
}
