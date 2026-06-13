/**
 * routes/arena.ts — Arena presence endpoints.
 *
 * The "arena" is a casual matchmaking lobby where subscribed players advertise
 * themselves as looking for a game. Active presence is tracked in a Redis set
 * (fast membership checks + cheap enumeration) with an ArenaEntry DB row for
 * persistent metadata (format preference, note). The two stores are kept in
 * sync by the join/leave routes and by the Socket.io disconnect handler
 * (plugins/socket.ts), which also removes from Redis on ungraceful disconnects.
 *
 * Endpoints:
 *   GET    /api/arena       — list active arena players (JWT required; read-only, no subscription check)
 *   POST   /api/arena/join  — join the arena (active subscription required)
 *   DELETE /api/arena/leave — leave the arena (JWT required)
 *
 * Socket.io events emitted:
 *   arena:join  { ...ArenaEntry, user }  — broadcast to ALL connected clients on join
 *   arena:leave { userId }               — broadcast to ALL connected clients on leave
 */
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireSubscription } from "../plugins/auth";
import {
  addToArena,
  removeFromArena,
  getArenaUserIds,
} from "../lib/redis";
import { io } from "../index";

const joinSchema = z.object({
  format: z.enum(["BO3", "BO5"]),
  note: z.string().max(100).optional(),
});

export async function arenaRoutes(app: FastifyInstance) {
  /**
   * GET /api/arena
   * Auth: JWT required (free tier can view; subscription not required).
   * Response: ArenaEntry[] ordered by join time (oldest first), each entry
   *   includes user { id, username, subscriptionStatus }.
   *   Returns [] when the Redis active-set is empty (no DB query needed).
   */
  app.get("/", { preHandler: [requireAuth] }, async () => {
    const activeIds = await getArenaUserIds();
    if (activeIds.length === 0) return [];

    return prisma.arenaEntry.findMany({
      where: { userId: { in: activeIds } },
      include: {
        user: {
          select: { id: true, username: true, subscriptionStatus: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });
  });

  /**
   * POST /api/arena/join
   * Auth: active subscription required.
   * Body: { format: "BO3"|"BO5", note?: string (max 100 chars) }
   * Response 200: the upserted ArenaEntry including user { id, username }.
   * Response 400: validation error.
   * Side effects:
   *   - Upserts ArenaEntry in DB (creates or updates; idempotent re-join).
   *   - Adds userId to Redis arena set.
   *   - Emits arena:join to ALL connected Socket.io clients.
   */
  app.post(
    "/join",
    { preHandler: [requireSubscription] },
    async (request, reply) => {
      const userId = (request.user as { id: string }).id;
      const body = joinSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: body.error.flatten() });
      }

      const entry = await prisma.arenaEntry.upsert({
        where: { userId },
        create: { userId, ...body.data },
        update: body.data,
        include: {
          user: { select: { id: true, username: true } },
        },
      });

      await addToArena(userId);
      io.emit("arena:join", entry);

      return entry;
    }
  );

  /**
   * DELETE /api/arena/leave
   * Auth: JWT required.
   * Response 200: { success: true }
   * Side effects:
   *   - Deletes the ArenaEntry row from DB.
   *   - Removes userId from Redis arena set.
   *   - Emits arena:leave { userId } to ALL connected Socket.io clients.
   */
  app.delete("/leave", { preHandler: [requireAuth] }, async (request) => {
    const userId = (request.user as { id: string }).id;

    await prisma.arenaEntry.deleteMany({ where: { userId } });
    await removeFromArena(userId);

    io.emit("arena:leave", { userId });

    return { success: true };
  });
}
