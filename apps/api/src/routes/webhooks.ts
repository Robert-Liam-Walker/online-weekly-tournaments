import { FastifyInstance, FastifyRequest } from "fastify";
import Stripe from "stripe";
import { stripe } from "../lib/stripe";
import { prisma } from "../lib/prisma";

export async function stripeWebhookRoute(app: FastifyInstance) {
  // Stripe requires the raw body — add a content type parser that preserves it
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      done(null, body);
    }
  );

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
