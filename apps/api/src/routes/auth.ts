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

export async function authRoutes(app: FastifyInstance) {
  app.post("/register", async (request, reply) => {
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

  app.post("/login", async (request, reply) => {
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
