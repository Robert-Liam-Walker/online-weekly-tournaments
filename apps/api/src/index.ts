import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import { Server } from "socket.io";
import { createServer } from "http";

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
import { stripeWebhookRoute } from "./routes/webhooks";
import { registerSocketHandlers } from "./plugins/socket";
import { startTournamentScheduler } from "./lib/scheduleTournaments";

const app = Fastify({ logger: true });
const httpServer = createServer(app.server);

export const io = new Server(httpServer, {
  cors: { origin: process.env.WEB_URL ?? "http://localhost:5173" },
});

async function main() {
  await app.register(cors, {
    origin: process.env.WEB_URL ?? "http://localhost:5173",
  });

  await app.register(jwt, {
    secret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  });

  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max replay upload
  });

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

  registerSocketHandlers(io);
  startTournamentScheduler();

  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: "0.0.0.0" });
  httpServer.listen(port + 1); // Socket.io on separate port in dev

  console.log(`API running on http://localhost:${port}`);
  console.log(`Socket.io running on http://localhost:${port + 1}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
});
