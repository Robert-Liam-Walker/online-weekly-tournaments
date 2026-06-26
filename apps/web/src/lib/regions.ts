// Region helper for Online Weekly Tournament Series.
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

/** Display order for the weekly hero grid. */
export const REGION_ORDER: TournamentRegion[] = ["EU", "NA_EAST", "NA_WEST"];

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

/** Compact event time in the region's tz, e.g. "8PM EST" (drops ":00" minutes;
 *  abbreviation reflects DST, so EDT in summer). */
export function regionTimeShort(iso: string, region: TournamentRegion): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: REGIONS[region].tz,
    timeZoneName: "short",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const minute = get("minute");
  const time = minute === "00" ? get("hour") : `${get("hour")}:${minute}`;
  return `${time}${get("dayPeriod").toUpperCase()} ${get("timeZoneName")}`;
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
