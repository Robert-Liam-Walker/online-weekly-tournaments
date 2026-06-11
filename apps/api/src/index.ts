import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { Server } from "socket.io";

import { prisma } from "./lib/prisma";
import { redis } from "./lib/redis";
import { authRoutes } from "./routes/auth";
import { arenaRoutes } from "./routes/arena";
import { challengeRoutes } from "./routes/challenges";
import { seriesRoutes } from "./routes/series";
import { friendRoutes } from "./routes/friends";
import { tournamentRoutes } from "./routes/tournaments";
import { deviceRoutes } from "./routes/device";
import { replayRoutes } from "./routes/replays";
import { subscriptionRoutes } from "./routes/subscriptions";
import { chatRoutes } from "./routes/chat";
import { rankRoutes } from "./routes/rank";
import { launcherRoutes } from "./routes/launcher";
import { stripeWebhookRoute } from "./routes/webhooks";
import { registerSocketHandlers } from "./plugins/socket";
import { startTournamentScheduler } from "./lib/scheduleTournaments";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie"],
      censor: "[redacted]",
    },
  },
});

// Socket.io rides on Fastify's own HTTP server so HTTP + websockets share a
// single port — required for single-port deployment behind EB/ALB.
// Exported because several routes (arena, challenges, friends, series) emit
// directly via `import { io } from "../index"`.
export const io = new Server(app.server, {
  cors: { origin: process.env.WEB_URL ?? "http://localhost:5173" },
});

/** Bound a health probe so a hung dependency can't stall the ALB check. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`probe timed out after ${ms}ms`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function main() {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error(
      "JWT_SECRET is not set — refusing to boot. Set JWT_SECRET in the environment (local dev: apps/api/.env)."
    );
  }

  // Security headers. CSP is disabled: this is a JSON API, not a page server.
  await app.register(helmet, { contentSecurityPolicy: false });

  await app.register(cors, {
    origin: process.env.WEB_URL ?? "http://localhost:5173",
  });

  // Global rate limit; sensitive routes set stricter per-route limits via
  // route `config.rateLimit` (see routes/auth.ts and routes/device.ts).
  // Backed by the shared Redis client so limits hold across EB instances;
  // per-route configs use child stores of the same Redis store automatically
  // (keys are prefixed "fastify-rate-limit-").
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    redis,
  });

  await app.register(jwt, { secret: jwtSecret });

  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max replay upload
  });

  // Centralized error mapping:
  //   - schema validation     -> 400 with the validation message
  //   - known client errors   -> their statusCode + message (4xx incl. 429)
  //   - everything else       -> logged in full, generic 500 (no internals leak)
  app.setErrorHandler((err, request, reply) => {
    if (err.validation) {
      return reply.code(400).send({ error: err.message });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    request.log.error(err);
    return reply.code(500).send({ error: "Internal server error" });
  });

  // ALB health check — deliberately top-level (not under /api) and exempt
  // from rate limiting. 200 when DB + Redis respond, 503 otherwise.
  app.get(
    "/health",
    { config: { rateLimit: false } },
    async (_request, reply) => {
      const checks = { db: "ok" as "ok" | "error", redis: "ok" as "ok" | "error" };
      try {
        await withTimeout(prisma.$queryRaw`SELECT 1`, 2_000);
      } catch {
        checks.db = "error";
      }
      try {
        await withTimeout(redis.ping(), 2_000);
      } catch {
        checks.redis = "error";
      }
      const healthy = checks.db === "ok" && checks.redis === "ok";
      return reply
        .code(healthy ? 200 : 503)
        .send({ status: healthy ? "ok" : "unhealthy", checks });
    }
  );

  // Stripe webhook must receive raw body — register before body parser
  await app.register(stripeWebhookRoute, { prefix: "/api/webhooks" });

  // Auth routes (no subscription required)
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(subscriptionRoutes, { prefix: "/api/subscriptions" });

  // Feature routes
  await app.register(arenaRoutes, { prefix: "/api/arena" });
  await app.register(challengeRoutes, { prefix: "/api/challenges" });
  await app.register(seriesRoutes, { prefix: "/api/series" });
  await app.register(friendRoutes, { prefix: "/api/friends" });
  await app.register(tournamentRoutes, { prefix: "/api/tournaments" });
  await app.register(deviceRoutes, { prefix: "/api/device" });
  await app.register(replayRoutes, { prefix: "/api/replays" });
  await app.register(chatRoutes, { prefix: "/api/chat" });
  await app.register(rankRoutes, { prefix: "/api/rank" });
  await app.register(launcherRoutes, { prefix: "/api/launcher" });

  registerSocketHandlers(io);
  startTournamentScheduler();

  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: "0.0.0.0" });

  console.log(`API + Socket.io running on http://localhost:${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  try {
    // Stop accepting new connections and drain in-flight requests first.
    await app.close();
    // app.close() already shut the shared HTTP server; io.close() is safe on
    // an already-closed server and disconnects any remaining sockets.
    io.close();
    await prisma.$disconnect();
    redis.disconnect();
  } finally {
    process.exit(0);
  }
});
