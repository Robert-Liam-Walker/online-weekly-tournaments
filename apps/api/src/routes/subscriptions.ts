/**
 * routes/subscriptions.ts — Stripe subscription checkout and billing portal.
 *
 * Subscription status is maintained authoritative in the DB via Stripe webhooks
 * (routes/webhooks.ts). These two endpoints initiate the flow for new
 * subscribers and provide a self-service billing portal for existing ones.
 *
 * Endpoints (under /api/subscriptions):
 *   POST /create-checkout  — start a Stripe Checkout session for a new subscription (JWT)
 *   POST /portal           — create a Stripe Billing Portal session to manage/cancel (JWT)
 *
 * Stripe Checkout session metadata includes userId so the webhook handler
 * (checkout.session.completed) can activate the subscription on the DB row.
 *
 * A Stripe Customer is created lazily on the first checkout and cached in
 * User.stripeCustomerId to avoid duplicate customers.
 */
import { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth";
import { stripe, STRIPE_PRICE_ID } from "../lib/stripe";
import { prisma } from "../lib/prisma";

export async function subscriptionRoutes(app: FastifyInstance) {
  /**
   * POST /api/subscriptions/create-checkout
   * Auth: JWT required.
   * Response 200: { url: string } — the Stripe Checkout session URL to redirect to.
   * Response 404: user not found in DB.
   * Response 409: user already has an ACTIVE subscription.
   * Side effects:
   *   - Creates a Stripe Customer if User.stripeCustomerId is null, persists it.
   *   - Creates a Stripe Checkout session (mode: "subscription") for STRIPE_PRICE_ID.
   *   - success_url redirects to WEB_URL/subscribe/success?session_id=...
   *   - cancel_url redirects to WEB_URL/subscribe
   */
  app.post(
    "/create-checkout",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = (request.user as { id: string }).id;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, stripeCustomerId: true, subscriptionStatus: true },
      });

      if (!user) return reply.code(404).send({ error: "User not found" });
      if (user.subscriptionStatus === "ACTIVE") {
        return reply.code(409).send({ error: "Already subscribed" });
      }

      // Create Stripe customer if needed
      let customerId = user.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({ email: user.email });
        customerId = customer.id;
        await prisma.user.update({
          where: { id: userId },
          data: { stripeCustomerId: customerId },
        });
      }

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
        success_url: `${process.env.WEB_URL}/subscribe/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.WEB_URL}/subscribe`,
        metadata: { userId },
      });

      return { url: session.url };
    }
  );

  /**
   * POST /api/subscriptions/portal
   * Auth: JWT required (user must already have a Stripe Customer).
   * Response 200: { url: string } — the Stripe Billing Portal session URL.
   * Response 400: user has no stripeCustomerId (never started a checkout).
   * Side effects: creates a Stripe Billing Portal session.
   *   return_url redirects to WEB_URL/settings after the portal session.
   */
  app.post(
    "/portal",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = (request.user as { id: string }).id;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { stripeCustomerId: true },
      });

      if (!user?.stripeCustomerId) {
        return reply.code(400).send({ error: "No billing account found" });
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: `${process.env.WEB_URL}/settings`,
      });

      return { url: session.url };
    }
  );
}
