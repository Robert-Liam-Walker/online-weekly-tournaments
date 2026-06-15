import type { FastifyInstance } from "fastify";

/**
 * Verify a Socket.io handshake JWT and return its user id, using the SAME
 * @fastify/jwt instance/secret as the HTTP routes (request.jwtVerify). The
 * signature and expiry are cryptographically verified, so a forged, tampered,
 * wrong-secret, or expired token throws.
 *
 * Security note: this replaces an earlier middleware that base64-decoded the
 * JWT payload WITHOUT verifying the signature — which let any client present a
 * self-made token and be trusted as any `userId` on the socket channel.
 *
 * Kept dependency-free (only a Fastify type) so it stays unit-testable without
 * loading the Prisma/Redis clients that `socket.ts` pulls in.
 */
export function authenticateSocketToken(app: FastifyInstance, token: string): string {
  const payload = app.jwt.verify(token) as { id?: unknown };
  if (typeof payload?.id !== "string" || payload.id === "") {
    throw new Error("Token payload missing a user id");
  }
  return payload.id;
}
