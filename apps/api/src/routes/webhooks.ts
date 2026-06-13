/**
 * routes/webhooks.ts — Stripe webhook handler.
 *
 * Stripe sends signed POST requests to /api/webhooks/stripe whenever a
 * subscription or payment event occurs. The signature is verified using
 * STRIPE_WEBHOOK_SECRET before any event processing.
 *
 * IMPORTANT: Stripe requires the raw (unparsed) request body to verify the
 * signature. This route registers its own content-type parser that preserves
 * the raw Buffer. It must be registered before any global JSON body parser,
 * which is ensured by registering it first in src/index.ts.
 *
 * Handled events:
 *   checkout.session.completed    — activate subscription OR create tournament entry
 *   customer.subscription.updated — sync status (active → ACTIVE, past_due → PAST_DUE, else CANCELED)
 *   customer.subscription.deleted — set status to CANCELED, clear subscriptionEndsAt
 *   invoice.payment_failed        — set status to PAST_DUE
 *
 * checkout.session.completed disambiguation:
 *   metadata.type === "tournament_entry" → create TournamentEntry + increment prizePool
 *   otherwise (subscription checkout)   → update User.subscriptionStatus to ACTIVE
 *   (The "otherwise" branch handles legacy subscription checkouts; new flows
 *    use customer.subscription.updated for status sync.)
 *
 * Endpoint:
 *   POST /api/webhooks/stripe  — public (no JWT; authenticated by Stripe signature)
 */
import { FastifyInstance, FastifyRequest } from "fastify";
import Stripe from "stripe";
import { stripe } from "../lib/stripe";
import { prisma } from "../lib/prisma";

export async function stripeWebhookRoute(app: FastifyInstance) {
  // Override Fastify's default JSON parser for this plugin scope so the raw
  // Buffer reaches the handler intact. Stripe's constructEvent() hashes the
  // raw bytes; any re-serialization would break signature verification.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      done(null, body);
    }
  );

  /**
   * POST /api/webhooks/stripe
   * Auth: Stripe HMAC signature (stripe-signature header + STRIPE_WEBHOOK_SECRET).
   * Response 200: { received: true }
   * Response 400: missing signature or signature verification failed.
   * Note: all unhandled event types are silently ignored (no switch default).
   */
  app.post("/stripe", async (request: FastifyRequest, reply) => {
    const sig = request.headers["stripe-signature"];
    if (!sig) return reply.code(400).send({ error: "Missing stripe-signature" });

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        request.body as Buffer,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET ?? ""
      );
    } catch (err) {
      return reply.code(400).send({ error: `Webhook error: ${err}` });
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const { type, userId, tournamentId } = session.metadata ?? {};

        if (type === "tournament_entry" && userId && tournamentId) {
          const amountPaid = session.amount_total ?? 0;
          await prisma.$transaction([
            prisma.tournamentEntry.create({
              data: { tournamentId, userId },
            }),
            prisma.tournament.update({
              where: { id: tournamentId },
              data: { prizePool: { increment: amountPaid } },
            }),
          ]);
        } else if (userId) {
          // Legacy subscription checkout
          await prisma.user.update({
            where: { id: userId },
            data: { subscriptionStatus: "ACTIVE" },
          });
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const user = await prisma.user.findFirst({
          where: { stripeCustomerId: sub.customer as string },
        });
        if (user) {
          const status =
            sub.status === "active"
              ? "ACTIVE"
              : sub.status === "past_due"
              ? "PAST_DUE"
              : "CANCELED";
          await prisma.user.update({
            where: { id: user.id },
            data: {
              subscriptionStatus: status,
              subscriptionEndsAt: new Date(sub.current_period_end * 1000),
            },
          });
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const user = await prisma.user.findFirst({
          where: { stripeCustomerId: sub.customer as string },
        });
        if (user) {
          await prisma.user.update({
            where: { id: user.id },
            data: { subscriptionStatus: "CANCELED", subscriptionEndsAt: null },
          });
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const user = await prisma.user.findFirst({
          where: { stripeCustomerId: invoice.customer as string },
        });
        if (user) {
          await prisma.user.update({
            where: { id: user.id },
            data: { subscriptionStatus: "PAST_DUE" },
          });
        }
        break;
      }
    }

    return { received: true };
  });
}
