import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../plugins/auth";
import { getIO } from "../plugins/socket";

// Direct messages between two users, layered on the existing ChatMessage model:
// a DM is just a deterministic 2-person channel ("dm:<idA>:<idB>", ids sorted),
// so no new table is needed. Realtime delivery reuses the per-user socket rooms
// ("user:<id>") the connection handler already joins.

/** Deterministic 1:1 DM channel id for a pair of users. */
function dmChannel(a: string, b: string): string {
  return "dm:" + [a, b].sort().join(":");
}

/** The other participant in a dm channel, or null if `me` isn't in it. */
function peerOf(channel: string, me: string): string | null {
  if (!channel.startsWith("dm:")) return null;
  const [x, y] = channel.slice(3).split(":");
  if (x === me) return y;
  if (y === me) return x;
  return null;
}

export async function messageRoutes(app: FastifyInstance) {
  // GET /api/messages — my conversations (peer + last message), newest first.
  app.get("/", { preHandler: [requireAuth] }, async (request) => {
    const me = (request.user as { id: string }).id;
    // Recent DMs I'm part of, reduced to the latest message per conversation.
    const recent = await prisma.chatMessage.findMany({
      where: { channel: { startsWith: "dm:", contains: me } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const latestByChannel = new Map<string, (typeof recent)[number]>();
    for (const m of recent) {
      if (peerOf(m.channel, me) && !latestByChannel.has(m.channel)) {
        latestByChannel.set(m.channel, m);
      }
    }
    const peerIds = [...latestByChannel.values()]
      .map((m) => peerOf(m.channel, me))
      .filter((p): p is string => p != null);
    const peers = await prisma.user.findMany({
      where: { id: { in: peerIds } },
      select: { id: true, username: true },
    });
    const peerById = new Map(peers.map((p) => [p.id, p]));
    return [...latestByChannel.values()]
      .map((m) => {
        const peerId = peerOf(m.channel, me)!;
        return {
          peer: { id: peerId, username: peerById.get(peerId)?.username ?? "Unknown" },
          lastMessage: { content: m.content, createdAt: m.createdAt, fromMe: m.userId === me },
        };
      })
      .sort(
        (a, b) =>
          new Date(b.lastMessage.createdAt).getTime() -
          new Date(a.lastMessage.createdAt).getTime()
      );
  });

  // GET /api/messages/:userId — history with one user (last 50, oldest first).
  app.get("/:userId", { preHandler: [requireAuth] }, async (request) => {
    const me = (request.user as { id: string }).id;
    const { userId } = request.params as { userId: string };
    return prisma.chatMessage.findMany({
      where: { channel: dmChannel(me, userId) },
      orderBy: { createdAt: "asc" },
      take: 50,
      include: { user: { select: { id: true, username: true } } },
    });
  });

  // POST /api/messages/:userId — send a DM; pushed to both users in realtime.
  app.post("/:userId", { preHandler: [requireAuth] }, async (request, reply) => {
    const me = (request.user as { id: string }).id;
    const { userId } = request.params as { userId: string };
    if (userId === me) return reply.code(400).send({ error: "You can't message yourself" });

    const body = z.object({ content: z.string().trim().min(1).max(500) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Message is required" });

    const peer = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!peer) return reply.code(404).send({ error: "User not found" });

    const message = await prisma.chatMessage.create({
      data: { channel: dmChannel(me, userId), userId: me, content: body.data.content },
      include: { user: { select: { id: true, username: true } } },
    });

    getIO()?.to(`user:${me}`).to(`user:${userId}`).emit("dm:message", message);
    return reply.code(201).send(message);
  });
}
