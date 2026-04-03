import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireSubscription } from "../plugins/auth";

export async function tournamentRoutes(app: FastifyInstance) {
  // GET /api/tournaments — list all (free tier can view)
  app.get("/", { preHandler: [requireAuth] }, async () => {
    return prisma.tournament.findMany({
      orderBy: { scheduledAt: "asc" },
      include: {
        _count: { select: { entries: true } },
      },
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

  // POST /api/tournaments/:id/register — requires subscription
  app.post(
    "/:id/register",
    { preHandler: [requireSubscription] },
    async (request, reply) => {
      const userId = (request.user as { id: string }).id;
      const { id } = request.params as { id: string };

      const tournament = await prisma.tournament.findUnique({ where: { id } });
      if (!tournament) {
        return reply.code(404).send({ error: "Tournament not found" });
      }
      if (tournament.status !== "REGISTRATION") {
        return reply
          .code(409)
          .send({ error: "Tournament is not open for registration" });
      }

      const entryCount = await prisma.tournamentEntry.count({
        where: { tournamentId: id },
      });
      if (entryCount >= tournament.maxEntrants) {
        return reply.code(409).send({ error: "Tournament is full" });
      }

      const entry = await prisma.tournamentEntry.create({
        data: { tournamentId: id, userId },
        include: {
          user: { select: { id: true, username: true, connectCode: true } },
        },
      });

      return reply.code(201).send(entry);
    }
  );

  // POST /api/tournaments — admin creates tournament
  app.post("/", { preHandler: [requireAuth] }, async (request, reply) => {
    const schema = z.object({
      name: z.string().min(3).max(100),
      description: z.string().max(500).optional(),
      scheduledAt: z.string().datetime(),
      format: z.enum(["SINGLE_ELIM", "DOUBLE_ELIM"]).default("SINGLE_ELIM"),
      seriesFormat: z.enum(["BO3", "BO5"]).default("BO5"),
      maxEntrants: z.number().int().min(4).max(256).default(64),
    });

    const body = schema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }

    const tournament = await prisma.tournament.create({
      data: {
        ...body.data,
        scheduledAt: new Date(body.data.scheduledAt),
      },
    });

    return reply.code(201).send(tournament);
  });
}
