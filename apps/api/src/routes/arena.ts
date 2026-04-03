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
  // GET /api/arena — list all available players (free tier can view)
  app.get("/", { preHandler: [requireAuth] }, async () => {
    const activeIds = await getArenaUserIds();
    if (activeIds.length === 0) return [];

    return prisma.arenaEntry.findMany({
      where: { userId: { in: activeIds } },
      include: {
        user: {
          select: { id: true, username: true, connectCode: true, subscriptionStatus: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });
  });

  // POST /api/arena/join — requires subscription
  app.post(
    "/join",
    { preHandler: [requireSubscription] },
    async (request, reply) => {
      const userId = (request.user as { id: string }).id;
      const body = joinSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: body.error.flatten() });
      }

      // Upsert arena entry in DB
      const entry = await prisma.arenaEntry.upsert({
        where: { userId },
        create: { userId, ...body.data },
        update: body.data,
        include: {
          user: { select: { id: true, username: true, connectCode: true } },
        },
      });

      await addToArena(userId);

      // Broadcast to all connected clients
      io.emit("arena:join", entry);

      return entry;
    }
  );

  // DELETE /api/arena/leave
  app.delete("/leave", { preHandler: [requireAuth] }, async (request) => {
    const userId = (request.user as { id: string }).id;

    await prisma.arenaEntry.deleteMany({ where: { userId } });
    await removeFromArena(userId);

    io.emit("arena:leave", { userId });

    return { success: true };
  });
}
