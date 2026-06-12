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
