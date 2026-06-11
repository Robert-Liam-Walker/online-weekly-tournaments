// Shared constants and types used by both api and web
export const WINS_NEEDED: Record<"BO3" | "BO5", number> = {
  BO3: 2,
  BO5: 3,
};

export const SUBSCRIPTION_PRICE_USD = 5;

export const SLIPPI_CONNECT_CODE_REGEX = /^[A-Z]{4}#\d{1,3}$/;

export type Format = "BO3" | "BO5";
export type SubscriptionStatus = "FREE" | "ACTIVE" | "PAST_DUE" | "CANCELED";

export * from "./bracket";
