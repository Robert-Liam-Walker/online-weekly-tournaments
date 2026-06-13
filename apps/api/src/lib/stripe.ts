/**
 * stripe.ts — Stripe client singleton + subscription price config.
 *
 * Purpose: Export a single shared Stripe instance and the configured price ID
 * for subscription checkout. All Stripe interactions (checkout sessions, webhook
 * verification, subscription lookups) must go through this module rather than
 * constructing their own clients.
 *
 * Configuration (environment variables):
 *   STRIPE_SECRET_KEY — Stripe API secret key (sk_live_... or sk_test_...).
 *                       If absent the client initialises with a placeholder
 *                       key; all live API calls will fail. Use
 *                       assertStripeConfigured() at route registration time to
 *                       surface misconfiguration early.
 *   STRIPE_PRICE_ID   — The recurring price ID for a paid subscription
 *                       (price_...). Defaults to "" if unset; routes that
 *                       create checkout sessions should also guard this.
 *
 * Key exports:
 *   stripe                  — the shared Stripe client.
 *   STRIPE_PRICE_ID         — price ID for subscription checkout sessions.
 *   assertStripeConfigured  — throws if STRIPE_SECRET_KEY is absent; call
 *                             this during server startup or route registration
 *                             when Stripe is required.
 *
 * Invariants:
 *   - Stripe is optional: the app boots without STRIPE_SECRET_KEY (free
 *     tournaments continue to work). Routes that touch paid features must gate
 *     on PAID_EVENTS_ENABLED (checked in routes/subscriptions.ts and
 *     routes/webhooks.ts) and call assertStripeConfigured().
 *   - The API version is pinned to "2024-04-10" to prevent silent behaviour
 *     changes on Stripe SDK upgrades.
 */
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY ?? "sk_test_placeholder";

export const stripe = new Stripe(key, {
  apiVersion: "2024-04-10",
});

export const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID ?? "";

/**
 * Assert that STRIPE_SECRET_KEY is configured.
 * @throws {Error} if the env var is missing.
 *
 * Call this at route registration / server startup so misconfiguration is
 * surfaced at boot rather than at the first live Stripe call.
 */
export function assertStripeConfigured() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }
}
