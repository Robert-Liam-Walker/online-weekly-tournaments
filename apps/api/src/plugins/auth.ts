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
