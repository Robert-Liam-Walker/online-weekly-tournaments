import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireSubscription, requireAuth } from "../plugins/auth";
import { io } from "../index";

export async function friendRoutes(app: FastifyInstance) {
  // GET /api/friends/requests/incoming — pending requests addressed to me
  app.get("/requests/incoming", { preHandler: [requireAuth] }, async (request) => {
    const userId = (request.user as { id: string }).id;
    return prisma.friendRequest.findMany({
      where: { requesteeId: userId, status: "PENDING" },
      include: {
        requester: { select: { id: true, username: true, connectCode: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  });

  // GET /api/friends — list accepted friends
  app.get("/", { preHandler: [requireAuth] }, async (request) => {
    const userId = (request.user as { id: string }).id;

    const friendships = await prisma.friendship.findMany({
      where: { OR: [{ initiatorId: userId }, { receiverId: userId }] },
      include: {
        initiator: { select: { id: true, username: true, connectCode: true } },
        receiver: { select: { id: true, username: true, connectCode: true } },
      },
    });

    return friendships.map((f) =>
      f.initiatorId === userId ? f.receiver : f.initiator
    );
  });

  // POST /api/friends/request — send friend request
  app.post(
    "/request",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = (request.user as { id: string }).id;
      const schema = z.object({
        connectCode: z.string(),
      });

      const body = schema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: body.error.flatten() });
      }

      const target = await prisma.user.findUnique({
        where: { connectCode: body.data.connectCode },
        select: { id: true, username: true },
      });
      if (!target) {
        return reply.code(404).send({ error: "User not found" });
      }
      if (target.id === userId) {
        return reply.code(400).send({ error: "Cannot add yourself" });
      }

      const existing = await prisma.friendRequest.findFirst({
        where: {
          OR: [
            { requesterId: userId, requesteeId: target.id },
            { requesterId: target.id, requesteeId: userId },
          ],
        },
      });
      if (existing) {
        return reply.code(409).send({ error: "Request already exists" });
      }

      const req = await prisma.friendRequest.create({
        data: { requesterId: userId, requesteeId: target.id },
        include: {
          requester: { select: { id: true, username: true, connectCode: true } },
        },
      });

      io.to(`user:${target.id}`).emit("friend:request", req);

      return reply.code(201).send(req);
    }
  );

  // PATCH /api/friends/request/:id/decline
  app.patch(
    "/request/:id/decline",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = (request.user as { id: string }).id;
      const { id } = request.params as { id: string };

      const req = await prisma.friendRequest.findUnique({ where: { id } });
      if (!req || req.requesteeId !== userId) {
        return reply.code(404).send({ error: "Friend request not found" });
      }
      if (req.status !== "PENDING") {
        return reply.code(409).send({ error: "Request already resolved" });
      }

      await prisma.friendRequest.update({
        where: { id },
        data: { status: "DECLINED" },
      });

      return { success: true };
    }
  );

  // PATCH /api/friends/request/:id/accept
  app.patch(
    "/request/:id/accept",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = (request.user as { id: string }).id;
      const { id } = request.params as { id: string };

      const req = await prisma.friendRequest.findUnique({ where: { id } });
      if (!req || req.requesteeId !== userId) {
        return reply.code(404).send({ error: "Friend request not found" });
      }
      if (req.status !== "PENDING") {
        return reply.code(409).send({ error: "Request already resolved" });
      }

      const [_, friendship] = await prisma.$transaction([
        prisma.friendRequest.update({
          where: { id },
          data: { status: "ACCEPTED" },
        }),
        prisma.friendship.create({
          data: { initiatorId: req.requesterId, receiverId: req.requesteeId },
        }),
      ]);

      return friendship;
    }
  );

  // DELETE /api/friends/:id — remove a friend
  app.delete("/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = (request.user as { id: string }).id;
    const { id: friendId } = request.params as { id: string };

    await prisma.friendship.deleteMany({
      where: {
        OR: [
          { initiatorId: userId, receiverId: friendId },
          { initiatorId: friendId, receiverId: userId },
        ],
      },
    });

    return { success: true };
  });
}
