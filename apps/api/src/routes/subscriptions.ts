import { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth";
import { stripe, STRIPE_PRICE_ID } from "../lib/stripe";
import { prisma } from "../lib/prisma";

export async function subscriptionRoutes(app: FastifyInstance) {
  // POST /api/subscriptions/create-checkout
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

  // POST /api/subscriptions/portal — Stripe billing portal (manage/cancel)
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
