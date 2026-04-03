import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireSubscription } from "../plugins/auth";
import { io } from "../index";

export async function challengeRoutes(app: FastifyInstance) {
  // GET /api/challenges/pending — incoming pending challenges for the logged-in user
  app.get("/pending", { preHandler: [requireAuth] }, async (request) => {
    const userId = (request.user as { id: string }).id;
    return prisma.challenge.findMany({
      where: { challengedId: userId, status: "PENDING" },
      include: {
        challenger: { select: { id: true, username: true, connectCode: true } },
        challenged: { select: { id: true, username: true, connectCode: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  });

  // POST /api/challenges — send a challenge (subscription required)
  app.post(
    "/",
    { preHandler: [requireSubscription] },
    async (request, reply) => {
      const userId = (request.user as { id: string }).id;
      const schema = z.object({
        challengedId: z.string(),
        format: z.enum(["BO3", "BO5"]),
      });

      const body = schema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: body.error.flatten() });
      }

      if (body.data.challengedId === userId) {
        return reply.code(400).send({ error: "Cannot challenge yourself" });
      }

      // Prevent duplicate pending challenges
      const existing = await prisma.challenge.findFirst({
        where: {
          challengerId: userId,
          challengedId: body.data.challengedId,
          status: "PENDING",
        },
      });
      if (existing) {
        return reply.code(409).send({ error: "Challenge already pending" });
      }

      const challenge = await prisma.challenge.create({
        data: {
          challengerId: userId,
          challengedId: body.data.challengedId,
          format: body.data.format,
        },
        include: {
          challenger: { select: { id: true, username: true, connectCode: true } },
          challenged: { select: { id: true, username: true, connectCode: true } },
        },
      });

      // Notify challenged user in real-time
      io.to(`user:${body.data.challengedId}`).emit("challenge:receive", challenge);

      return reply.code(201).send(challenge);
    }
  );

  // PATCH /api/challenges/:id/accept
  app.patch(
    "/:id/accept",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = (request.user as { id: string }).id;
      const { id } = request.params as { id: string };

      const challenge = await prisma.challenge.findUnique({ where: { id } });
      if (!challenge || challenge.challengedId !== userId) {
        return reply.code(404).send({ error: "Challenge not found" });
      }
      if (challenge.status !== "PENDING") {
        return reply.code(409).send({ error: "Challenge is no longer pending" });
      }

      const [updatedChallenge, series] = await prisma.$transaction([
        prisma.challenge.update({
          where: { id },
          data: { status: "ACCEPTED", resolvedAt: new Date() },
        }),
        prisma.series.create({
          data: {
            player1Id: challenge.challengerId,
            player2Id: challenge.challengedId,
            format: challenge.format,
          },
        }),
      ]);

      await prisma.challenge.update({
        where: { id },
        data: { seriesId: series.id },
      });

      const payload = { challenge: updatedChallenge, series };
      io.to(`user:${challenge.challengerId}`).to(`user:${userId}`).emit("challenge:accepted", payload);

      return payload;
    }
  );

  // PATCH /api/challenges/:id/decline
  app.patch(
    "/:id/decline",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = (request.user as { id: string }).id;
      const { id } = request.params as { id: string };

      const challenge = await prisma.challenge.findUnique({ where: { id } });
      if (!challenge || challenge.challengedId !== userId) {
        return reply.code(404).send({ error: "Challenge not found" });
      }
      if (challenge.status !== "PENDING") {
        return reply.code(409).send({ error: "Challenge is no longer pending" });
      }

      const updated = await prisma.challenge.update({
        where: { id },
        data: { status: "DECLINED", resolvedAt: new Date() },
      });

      return updated;
    }
  );
}
