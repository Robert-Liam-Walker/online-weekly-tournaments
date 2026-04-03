import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../plugins/auth";
import { stripe } from "../lib/stripe";

// Prize distribution (must sum to 100)
export const PRIZE_SPLIT = { first: 50, second: 25, third: 10, platform: 15 };

export async function tournamentRoutes(app: FastifyInstance) {
  // GET /api/tournaments — list all
  app.get("/", { preHandler: [requireAuth] }, async () => {
    return prisma.tournament.findMany({
      orderBy: { scheduledAt: "asc" },
      include: { _count: { select: { entries: true } } },
    });
  });

  // GET /api/tournaments/:id — full bracket detail
  app.get("/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const tournament = await prisma.tournament.findUnique({
      where: { id },
      include: {
        entries: {
          include: {
            user: { select: { id: true, username: true, connectCode: true } },
          },
        },
        matches: {
          orderBy: [{ round: "asc" }, { matchNumber: "asc" }],
          include: { series: true },
        },
      },
    });
    if (!tournament) return reply.code(404).send({ error: "Tournament not found" });
    return tournament;
  });

  // POST /api/tournaments/:id/register
  // Free tournament → register immediately
  // Paid tournament → return Stripe checkout URL; entry created by webhook
  app.post("/:id/register", { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = (request.user as { id: string }).id;
    const { id } = request.params as { id: string };

    const tournament = await prisma.tournament.findUnique({ where: { id } });
    if (!tournament) return reply.code(404).send({ error: "Tournament not found" });
    if (tournament.status !== "REGISTRATION") {
      return reply.code(409).send({ error: "Tournament is not open for registration" });
    }

    const entryCount = await prisma.tournamentEntry.count({ where: { tournamentId: id } });
    if (entryCount >= tournament.maxEntrants) {
      return reply.code(409).send({ error: "Tournament is full" });
    }

    const alreadyEntered = await prisma.tournamentEntry.findUnique({
      where: { tournamentId_userId: { tournamentId: id, userId } },
    });
    if (alreadyEntered) return reply.code(409).send({ error: "Already registered" });

    // Free tournament — register directly
    if (tournament.entryFee === 0) {
      const entry = await prisma.tournamentEntry.create({
        data: { tournamentId: id, userId },
        include: { user: { select: { id: true, username: true, connectCode: true } } },
      });
      return reply.code(201).send({ entry });
    }

    // Paid tournament — create Stripe checkout session
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, stripeCustomerId: true },
    });
    if (!user) return reply.code(404).send({ error: "User not found" });

    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email });
      customerId = customer.id;
      await prisma.user.update({ where: { id: userId }, data: { stripeCustomerId: customerId } });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: tournament.entryFee,
            product_data: { name: `${tournament.name} — Entry Fee` },
          },
          quantity: 1,
        },
      ],
      success_url: `${process.env.WEB_URL}/tournaments/success?tournament_id=${id}`,
      cancel_url: `${process.env.WEB_URL}/tournaments`,
      metadata: { type: "tournament_entry", tournamentId: id, userId },
    });

    return { checkoutUrl: session.url };
  });

  // POST /api/tournaments — create tournament
  app.post("/", { preHandler: [requireAuth] }, async (request, reply) => {
    const schema = z.object({
      name: z.string().min(3).max(100),
      description: z.string().max(500).optional(),
      scheduledAt: z.string().datetime(),
      format: z.enum(["SINGLE_ELIM", "DOUBLE_ELIM"]).default("SINGLE_ELIM"),
      seriesFormat: z.enum(["BO3", "BO5"]).default("BO5"),
      maxEntrants: z.number().int().min(4).max(256).default(64),
      entryFee: z.number().int().min(0).default(0),
    });

    const body = schema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    const tournament = await prisma.tournament.create({
      data: { ...body.data, scheduledAt: new Date(body.data.scheduledAt) },
    });

    return reply.code(201).send(tournament);
  });
}
