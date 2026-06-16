// Custom in-game name format: 5 uppercase letters + 2 digits, e.g. "ABCDE12".
// Optional — set on the web. Players without a custom name show as GUEST + their
// registration order in the tournament (see entrantName). The stable account id
// is separate and never changes.
export const DISPLAY_NAME_REGEX = /^[A-Z]{5}[0-9]{2}$/;

// The name shown for an entrant: their custom name if set, otherwise
// GUEST + their 1-based registration order in the tournament, zero-padded to two
// digits (GUEST01, GUEST02, ...). Tournaments cap at 16 entrants, so the order
// always fits two digits; clamp defensively anyway.
export function entrantName(customName: string | null | undefined, order: number): string {
  if (customName) return customName;
  const n = order > 99 ? 99 : order < 1 ? 1 : order;
  return "GUEST" + String(n).padStart(2, "0");
}
