/**
 * index.ts — Shared constants, types, and the bracket engine for @foxtrot/shared.
 *
 * Purpose: Single entry point for the shared package used by both apps/api and
 * apps/web. Exports constants and types that must stay identical between the
 * API and the web client (avoiding drift between duplicated definitions).
 *
 * Key exports (direct):
 *   WINS_NEEDED          — map from series format (BO3/BO5) to games needed to win.
 *   SUBSCRIPTION_PRICE_USD — monthly subscription price in USD (display / Stripe).
 *   USERNAME_REGEX       — validation regex for player usernames; see below.
 *   Format               — "BO3" | "BO5" series format union.
 *   SubscriptionStatus   — "FREE" | "ACTIVE" | "PAST_DUE" | "CANCELED" union.
 *
 * Key exports (re-exported from ./bracket):
 *   generateDoubleElim, reportResult, getReadyMatches, isComplete,
 *   getChampion, getPlacements — the pure double-elimination engine.
 *   DEBracket, MatchState, BracketMatchDef, Placement, etc. — bracket types.
 *   See bracket.ts for full documentation.
 *
 * Username constraints:
 *   3–15 alphanumeric characters (A-Z, a-z, 0-9, no spaces or symbols).
 *   Upper bound matches Dolphin's MAX_NAME_LENGTH (15); the in-game font
 *   renders only A-Z/0-9/space, so special characters are excluded. The
 *   regex is the single source of truth: the API validates on write, the web
 *   client validates on input, and Dolphin renders whatever the API accepted.
 */

// Shared constants and types used by both api and web
export const WINS_NEEDED: Record<"BO3" | "BO5", number> = {
  BO3: 2,
  BO5: 3,
};

export const SUBSCRIPTION_PRICE_USD = 5;

// 3-15 alphanumeric — intentional: the in-game font renders A-Z/0-9/space;
// 15 matches Dolphin's MAX_NAME_LENGTH.
export const USERNAME_REGEX = /^[A-Za-z0-9]{3,15}$/;

export type Format = "BO3" | "BO5";
export type SubscriptionStatus = "FREE" | "ACTIVE" | "PAST_DUE" | "CANCELED";

export * from "./bracket";
