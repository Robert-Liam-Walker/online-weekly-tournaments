/**
 * plugins/auth.ts — Fastify preHandler guards for HTTP routes.
 *
 * Three guards are exported; every protected route names one (or both in
 * sequence) in its `preHandler` array:
 *
 *   requireAuth          — valid JWT in Authorization header; 401 otherwise.
 *   requireAdmin         — valid JWT + User.role === "ADMIN"; 403 otherwise.
 *   requireSubscription  — valid JWT + User.subscriptionStatus === "ACTIVE"; 403 otherwise.
 *
 * Guards that reject a request call reply.send() themselves (setting
 * reply.sent = true), so callers must check `if (reply.sent) return` before
 * continuing when chaining multiple guards manually.
 *
 * Socket.io auth is handled separately in plugins/socket.ts.
 */
import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../lib/prisma";

/**
 * Verify the JWT in the Authorization header via @fastify/jwt.
 * Populates request.user = { id: string } on success.
 * Sends 401 and short-circuits on failure.
 */
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

/**
 * Require a valid JWT AND User.role === "ADMIN".
 * Chains requireAuth first; if that already rejected (reply.sent), returns
 * immediately without an extra DB lookup. Sends 403 for non-admin users.
 *
 * @param request - Fastify request (must carry a valid JWT to proceed).
 * @param reply   - Fastify reply; may already be sent if requireAuth rejected.
 */
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

/**
 * Require a valid JWT AND User.subscriptionStatus === "ACTIVE".
 * Chains requireAuth first; returns early if that already rejected. Sends 403
 * with code "SUBSCRIPTION_REQUIRED" for users without an active subscription.
 *
 * Routes that need an active subscription to perform write actions (arena join,
 * challenge send, etc.) use this guard.
 *
 * @param request - Fastify request.
 * @param reply   - Fastify reply.
 */
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
