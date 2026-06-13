/**
 * routes/challenges.ts — Direct-challenge lifecycle endpoints.
 *
 * A Challenge is a one-to-one match request from one player to another. The
 * flow is: send → (accept | decline). Accepting creates a linked Series.
 *
 * Endpoints (all under /api/challenges):
 *   GET   /pending          — incoming PENDING challenges for the authenticated user (JWT)
 *   POST  /                 — send a challenge to another player (subscription required)
 *   PATCH /:id/accept       — accept a challenge (must be the challenged player; JWT)
 *   PATCH /:id/decline      — decline a challenge (must be the challenged player; JWT)
 *
 * Socket.io events emitted:
 *   challenge:receive  { ...Challenge, challenger, challenged }
 *       → emitted to `user:<challengedId>` room on POST /
 *   challenge:accepted { challenge, series }
 *       → emitted to both `user:<challengerId>` and `user:<challengedId>` on accept
 *
 * Note: The decline route does NOT emit a socket event — the challenger's UI
 * polls or relies on the pending-list response to detect declines.
 */
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireSubscription } from "../plugins/auth";
import { io } from "../index";

export async function challengeRoutes(app: FastifyInstance) {
  /**
   * GET /api/challenges/pending
   * Auth: JWT required.
   * Response 200: Challenge[] (status=PENDING, challengedId=me), newest first.
   *   Each entry includes challenger { id, username } and challenged { id, username }.
   */
  app.get("/pending", { preHandler: [requireAuth] }, async (request) => {
    const userId = (request.user as { id: string }).id;
    return prisma.challenge.findMany({
      where: { challengedId: userId, status: "PENDING" },
      include: {
        challenger: { select: { id: true, username: true } },
        challenged: { select: { id: true, username: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  });

  /**
   * POST /api/challenges
   * Auth: active subscription required.
   * Body: { challengedId: string (user id), format: "BO3"|"BO5" }
   * Response 201: the created Challenge including challenger + challenged users.
   * Response 400: validation error or self-challenge attempt.
   * Response 409: a PENDING challenge from this user to this target already exists.
   * Side effects: emits challenge:receive to `user:<challengedId>` Socket.io room.
   */
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
          challenger: { select: { id: true, username: true } },
          challenged: { select: { id: true, username: true } },
        },
      });

      // Notify challenged user in real-time
      io.to(`user:${body.data.challengedId}`).emit("challenge:receive", challenge);

      return reply.code(201).send(challenge);
    }
  );

  /**
   * PATCH /api/challenges/:id/accept
   * Auth: JWT required (must be the challenged user).
   * Params: id — challenge id.
   * Response 200: { challenge: updatedChallenge, series: newSeries }
   * Response 404: challenge not found or caller is not the challenged player.
   * Response 409: challenge is no longer PENDING.
   * Side effects:
   *   - Updates Challenge status to ACCEPTED + sets resolvedAt.
   *   - Creates a new Series (player1=challenger, player2=challenged).
   *   - Links the series back onto the challenge (separate update; see code comment).
   *   - Emits challenge:accepted { challenge, series } to both players' rooms.
   */
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

  /**
   * PATCH /api/challenges/:id/decline
   * Auth: JWT required (must be the challenged user).
   * Params: id — challenge id.
   * Response 200: the updated Challenge row (status=DECLINED).
   * Response 404: challenge not found or caller is not the challenged player.
   * Response 409: challenge is no longer PENDING.
   * Side effects: updates Challenge status to DECLINED + sets resolvedAt.
   *   No socket event is emitted on decline.
   */
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
