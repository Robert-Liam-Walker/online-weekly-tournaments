/**
 * routes/device.ts — Device link flow (game client ↔ web authentication).
 *
 * Replaces the old /game-login connect-code model (removed Phase 3, 2026-06-12).
 * Allows a game client that has no web session to obtain a JWT by having the
 * player confirm the link from their already-authenticated browser session.
 *
 * Flow:
 *   1. Game client:   POST /api/device/link/start    → { code, expiresInMinutes }
 *                     Displays the 6-char code in-game to the player.
 *   2. Web player:    POST /api/device/link/confirm  { code }   (JWT required)
 *                     Binds the code to the authenticated user.
 *   3. Game client:   GET  /api/device/link/status?code=...
 *                     Polls (≈every 3 s) until status is "CONFIRMED", then
 *                     receives a 30-day JWT. Code is consumed (one-time use).
 *
 * Code alphabet excludes visually ambiguous characters (0/O, 1/I) to reduce
 * transcription errors. TTL is 10 minutes; expired codes return EXPIRED status.
 *
 * Endpoints (under /api/device):
 *   POST /link/start    — mint a link code (unauthenticated; 10 req/min/IP)
 *   POST /link/confirm  — bind code to authenticated user (JWT required; 15 req/min/IP)
 *   GET  /link/status   — poll status; returns JWT once on CONFIRMED (60 req/min/IP)
 */
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../plugins/auth";

const CODE_TTL_MINUTES = 10;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

function generateCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

export async function deviceRoutes(app: FastifyInstance) {
  /**
   * POST /api/device/link/start
   * Auth: none (unauthenticated by design — the game client has no session yet).
   * Rate limit: 10 req/min/IP (each call writes a DeviceLinkCode row).
   * Response 200: { code: string (6 chars), expiresInMinutes: 10 }
   * Side effects: creates a DeviceLinkCode row with a 10-minute expiry.
   */
  app.post(
    "/link/start",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async () => {
      const code = generateCode();
      await prisma.deviceLinkCode.create({
        data: {
          code,
          expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000),
        },
      });
      return { code, expiresInMinutes: CODE_TTL_MINUTES };
    }
  );

  /**
   * POST /api/device/link/confirm
   * Auth: JWT required (the web-logged-in player confirms for themselves).
   * Rate limit: 15 req/min/IP.
   * Body: { code: string (exactly 6 chars, case-insensitive) }
   * Response 200: { confirmed: true }
   * Response 400: invalid code format.
   * Response 404: unknown code.
   * Response 409: code already confirmed.
   * Response 410: code expired.
   * Side effects: sets DeviceLinkCode.userId + confirmedAt.
   */
  app.post(
    "/link/confirm",
    {
      preHandler: [requireAuth],
      config: { rateLimit: { max: 15, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const userId = (request.user as { id: string }).id;
      const schema = z.object({ code: z.string().length(6) });
      const body = schema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

      const link = await prisma.deviceLinkCode.findUnique({
        where: { code: body.data.code.toUpperCase() },
      });
      if (!link) return reply.code(404).send({ error: "Unknown code" });
      if (link.expiresAt < new Date()) return reply.code(410).send({ error: "Code expired" });
      if (link.confirmedAt) return reply.code(409).send({ error: "Code already confirmed" });

      await prisma.deviceLinkCode.update({
        where: { id: link.id },
        data: { userId, confirmedAt: new Date() },
      });
      return { confirmed: true };
    }
  );

  /**
   * GET /api/device/link/status
   * Auth: none (game client has no JWT yet; the code serves as the credential).
   * Rate limit: 60 req/min/IP. Poll cadence is ~3 s (≈20/min), leaving 3×
   *   headroom so a well-behaved client never trips the limit during the 10-min window.
   * Query params: code (required) — the 6-char code from /link/start.
   * Response 200 (polling): { status: "PENDING" | "EXPIRED" }
   * Response 200 (completed): { status: "CONFIRMED", user: { id, username }, token: string (JWT 30d) }
   *   The JWT is returned exactly once — the code is marked consumedAt and any
   *   subsequent poll returns 410.
   * Response 400: missing code param.
   * Response 404: unknown code or linked user not found.
   * Response 410: code already consumed (token was already issued).
   * Side effects: sets DeviceLinkCode.consumedAt on first CONFIRMED read.
   */
  app.get(
    "/link/status",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { code } = request.query as { code?: string };
      if (!code) return reply.code(400).send({ error: "code required" });

      const link = await prisma.deviceLinkCode.findUnique({
        where: { code: code.toUpperCase() },
      });
      if (!link) return reply.code(404).send({ error: "Unknown code" });
      if (link.consumedAt) return reply.code(410).send({ error: "Code already used" });
      if (link.expiresAt < new Date()) return { status: "EXPIRED" };
      if (!link.confirmedAt || !link.userId) return { status: "PENDING" };

      const user = await prisma.user.findUnique({
        where: { id: link.userId },
        select: { id: true, username: true },
      });
      if (!user) return reply.code(404).send({ error: "User not found" });

      await prisma.deviceLinkCode.update({
        where: { id: link.id },
        data: { consumedAt: new Date() },
      });
      const token = app.jwt.sign({ id: user.id }, { expiresIn: "30d" });
      return { status: "CONFIRMED", user, token };
    }
  );
}
