import { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma";

const registerSchema = z.object({
  username: z.string().min(3).max(30),
  email: z.string().email(),
  password: z.string().min(8),
  connectCode: z
    .string()
    .regex(/^[A-Z]{4}#\d{1,3}$/, "Connect code must be like FOXT#123"),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

// Brute-force protection: account creation and credential checks get a much
// stricter per-IP budget than the global API limit.
const strictRateLimit = {
  rateLimit: { max: 10, timeWindow: "1 minute" },
};

export async function authRoutes(app: FastifyInstance) {
  app.post("/register", { config: strictRateLimit }, async (request, reply) => {
    const body = registerSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }

    const { username, email, password, connectCode } = body.data;

    const existing = await prisma.user.findFirst({
      where: { OR: [{ email }, { username }, { connectCode }] },
    });
    if (existing) {
      return reply
        .code(409)
        .send({ error: "Email, username, or connect code already in use" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { username, email, passwordHash, connectCode },
      select: { id: true, username: true, email: true, connectCode: true, subscriptionStatus: true },
    });

    const token = app.jwt.sign({ id: user.id }, { expiresIn: "7d" });
    return reply.code(201).send({ user, token });
  });

  app.post("/login", { config: strictRateLimit }, async (request, reply) => {
    const body = loginSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }

    const user = await prisma.user.findUnique({
      where: { email: body.data.email },
    });
    if (!user) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(body.data.password, user.passwordHash);
    if (!valid) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const token = app.jwt.sign({ id: user.id }, { expiresIn: "7d" });
    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        connectCode: user.connectCode,
        subscriptionStatus: user.subscriptionStatus,
      },
      token,
    };
  });

  // Game-client login: the FoxTrot Dolphin build authenticates with the
  // connect code from the player's Slippi login (user.json).
  // DEPRECATED (2026-06-11): the Dolphin client now uses the device-link
  // flow exclusively; this route remains only for dev smoke scripts and old
  // builds. Strictly rate-limited; REMOVE once the release client is
  // confirmed in-game and the smoke scripts are migrated to device-link.
  app.post("/game-login", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const schema = z.object({ connectCode: z.string().min(3).max(10) });
    const body = schema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    const user = await prisma.user.findUnique({
      where: { connectCode: body.data.connectCode.toUpperCase() },
    });
    if (!user) {
      return reply
        .code(404)
        .send({ error: "No FoxTrot account with this connect code — sign up on the web first" });
    }

    const token = app.jwt.sign({ id: user.id }, { expiresIn: "7d" });
    return {
      user: { id: user.id, username: user.username, connectCode: user.connectCode },
      token,
    };
  });

  app.get(
    "/me",
    { preHandler: [(req, rep) => req.jwtVerify()] },
    async (request) => {
      const { id } = request.user as { id: string };
      return prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          username: true,
          email: true,
          connectCode: true,
          subscriptionStatus: true,
          subscriptionEndsAt: true,
          createdAt: true,
        },
      });
    }
  );
}
