import { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../plugins/auth";

export async function chatRoutes(app: FastifyInstance) {
  // GET /api/chat/:channel — last 50 messages, oldest first
  app.get("/:channel", { preHandler: [requireAuth] }, async (request, reply) => {
    const { channel } = request.params as { channel: string };

    const messages = await prisma.chatMessage.findMany({
      where: { channel },
      orderBy: { createdAt: "asc" },
      take: 50,
      include: { user: { select: { id: true, username: true } } },
    });

    return messages;
  });
}
