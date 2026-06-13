/**
 * routes/chat.ts — Channel chat history (REST).
 *
 * Provides the initial message load for a chat channel. Live message delivery
 * uses Socket.io (chat:message event in plugins/socket.ts); this REST endpoint
 * is called once on channel join to populate the message history.
 *
 * Endpoints (under /api/chat):
 *   GET /:channel  — fetch the last 50 messages for a named channel (JWT required)
 */
import { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../plugins/auth";

export async function chatRoutes(app: FastifyInstance) {
  /**
   * GET /api/chat/:channel
   * Auth: JWT required.
   * Params: channel — arbitrary channel name (e.g. "general", "tournament-123").
   * Response 200: ChatMessage[] (last 50, oldest first), each including
   *   user { id, username }.
   * Note: channel names are not validated against an allowlist; any string
   *   creates a channel on first message. Access control is JWT-only.
   */
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
