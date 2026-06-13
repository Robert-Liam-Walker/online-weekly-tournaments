/**
 * routes/friends.ts — Friend request and friendship management.
 *
 * Friends are tracked as two separate models:
 *   FriendRequest — directional request (requester → requestee), PENDING/ACCEPTED/DECLINED.
 *   Friendship    — undirected pair created when a request is accepted; queried
 *                   with OR across both directions.
 *
 * Sending a friend request does NOT require a subscription (only JWT). All
 * other write operations also need only a JWT.
 *
 * Endpoints (all under /api/friends):
 *   GET    /                         — list accepted friends for the authenticated user (JWT)
 *   GET    /requests/incoming        — list incoming PENDING requests (JWT)
 *   POST   /request                  — send a friend request by username (JWT)
 *   PATCH  /request/:id/accept       — accept an incoming request, creates Friendship (JWT)
 *   PATCH  /request/:id/decline      — decline an incoming request (JWT)
 *   DELETE /:id                      — remove a friend (JWT; :id is the friend's userId)
 *
 * Socket.io events emitted:
 *   friend:request { ...FriendRequest, requester }
 *       → emitted to `user:<requesteeId>` on POST /request
 */
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireSubscription, requireAuth } from "../plugins/auth";
import { io } from "../index";

export async function friendRoutes(app: FastifyInstance) {
  /**
   * GET /api/friends/requests/incoming
   * Auth: JWT required.
   * Response 200: FriendRequest[] (status=PENDING, requesteeId=me), newest first.
   *   Each includes requester { id, username }.
   */
  app.get("/requests/incoming", { preHandler: [requireAuth] }, async (request) => {
    const userId = (request.user as { id: string }).id;
    return prisma.friendRequest.findMany({
      where: { requesteeId: userId, status: "PENDING" },
      include: {
        requester: { select: { id: true, username: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  });

  /**
   * GET /api/friends
   * Auth: JWT required.
   * Response 200: User[] — the other side of each Friendship (id, username).
   *   Queries Friendship rows where the caller is either initiator or receiver,
   *   then maps each row to the other user object.
   */
  app.get("/", { preHandler: [requireAuth] }, async (request) => {
    const userId = (request.user as { id: string }).id;

    const friendships = await prisma.friendship.findMany({
      where: { OR: [{ initiatorId: userId }, { receiverId: userId }] },
      include: {
        initiator: { select: { id: true, username: true } },
        receiver: { select: { id: true, username: true } },
      },
    });

    return friendships.map((f) =>
      f.initiatorId === userId ? f.receiver : f.initiator
    );
  });

  /**
   * POST /api/friends/request
   * Auth: JWT required (no subscription check).
   * Body: { username: string } — case-insensitive lookup.
   * Response 201: the created FriendRequest including requester { id, username }.
   * Response 400: validation error or self-request.
   * Response 404: target username not found.
   * Response 409: a request already exists in either direction between these users.
   * Side effects: emits friend:request to `user:<requesteeId>` Socket.io room.
   */
  app.post(
    "/request",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = (request.user as { id: string }).id;
      const schema = z.object({
        username: z.string(),
      });

      const body = schema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: body.error.flatten() });
      }

      const target = await prisma.user.findFirst({
        where: { username: { equals: body.data.username, mode: "insensitive" } },
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
          requester: { select: { id: true, username: true } },
        },
      });

      io.to(`user:${target.id}`).emit("friend:request", req);

      return reply.code(201).send(req);
    }
  );

  /**
   * PATCH /api/friends/request/:id/decline
   * Auth: JWT required (must be the requestee).
   * Params: id — FriendRequest id.
   * Response 200: { success: true }
   * Response 404: request not found or caller is not the requestee.
   * Response 409: request already resolved (accepted or declined).
   */
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

  /**
   * PATCH /api/friends/request/:id/accept
   * Auth: JWT required (must be the requestee).
   * Params: id — FriendRequest id.
   * Response 200: the created Friendship row.
   * Response 404: request not found or caller is not the requestee.
   * Response 409: request already resolved.
   * Side effects (atomic transaction):
   *   - Updates FriendRequest status to ACCEPTED.
   *   - Creates Friendship { initiatorId: requester, receiverId: requestee }.
   */
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

  /**
   * DELETE /api/friends/:id
   * Auth: JWT required.
   * Params: id — the friend's userId (not a friendship row id).
   * Response 200: { success: true }
   * Side effects: deletes Friendship rows in both directions (OR query) so the
   *   caller doesn't need to know which side originally sent the request.
   *   Silently succeeds even if no friendship exists.
   */
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
