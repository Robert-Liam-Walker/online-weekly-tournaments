import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../lib/prisma";

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    reply.code(401).send({ error: "Unauthorized" });
  }
}

/** Admin-only gate: valid JWT and User.role === ADMIN, otherwise 403. */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await requireAuth(request, reply);
  if (reply.sent) return;

  const user = await prisma.user.findUnique({
    where: { id: (request.user as { id: string }).id },
    select: { role: true },
  });

  if (user?.role !== "ADMIN") {
    reply.code(403).send({ error: "Admin access required", code: "ADMIN_REQUIRED" });
  }
}

export async function requireSubscription(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await requireAuth(request, reply);
  if (reply.sent) return;

  const user = await prisma.user.findUnique({
    where: { id: (request.user as { id: string }).id },
    select: { subscriptionStatus: true },
  });

  if (user?.subscriptionStatus !== "ACTIVE") {
    reply
      .code(403)
      .send({ error: "Active subscription required", code: "SUBSCRIPTION_REQUIRED" });
  }
}
