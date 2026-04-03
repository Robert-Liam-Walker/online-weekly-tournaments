import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY ?? "sk_test_placeholder";

export const stripe = new Stripe(key, {
  apiVersion: "2024-04-10",
});

export const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID ?? "";

export function assertStripeConfigured() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }
}
