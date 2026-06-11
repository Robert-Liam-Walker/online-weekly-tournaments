import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../plugins/auth";

// Device link flow (replaces the game-login connect-code trust model):
//   1. Game client: POST /api/device/link/start          -> { code }
//      and shows the code in-game.
//   2. Player, logged in on the web: POST /link/confirm { code }
//   3. Game client polls GET /link/status?code=...       -> { status }
//      and on CONFIRMED receives a JWT once (the code is consumed).

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
  // Game client requests a link code (unauthenticated by design)
  app.post("/link/start", async () => {
    const code = generateCode();
    await prisma.deviceLinkCode.create({
      data: {
        code,
        expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000),
      },
    });
    return { code, expiresInMinutes: CODE_TTL_MINUTES };
  });

  // Logged-in player confirms the code shown by their game client
  app.post("/link/confirm", { preHandler: [requireAuth] }, async (request, reply) => {
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
  });

  // Game client polls until confirmed; the token is handed out exactly once
  app.get("/link/status", async (request, reply) => {
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
      select: { id: true, username: true, connectCode: true },
    });
    if (!user) return reply.code(404).send({ error: "User not found" });

    await prisma.deviceLinkCode.update({
      where: { id: link.id },
      data: { consumedAt: new Date() },
    });
    const token = app.jwt.sign({ id: user.id }, { expiresIn: "30d" });
    return { status: "CONFIRMED", user, token };
  });
}
