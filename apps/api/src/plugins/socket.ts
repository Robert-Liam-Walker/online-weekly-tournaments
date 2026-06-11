import { Server, Socket } from "socket.io";
import { prisma } from "../lib/prisma";
import { addToArena, removeFromArena } from "../lib/redis";

// Held here so libs/routes can emit without importing src/index.ts (cycle).
let ioInstance: Server | null = null;

/** The live Socket.io server, or null before registerSocketHandlers runs. */
export function getIO(): Server | null {
  return ioInstance;
}

export function registerSocketHandlers(io: Server) {
  ioInstance = io;
  io.use(async (socket, next) => {
    // Validate JWT from handshake auth
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error("Missing token"));

    // Minimal JWT decode — in production use jose or jsonwebtoken
    try {
      const payload = JSON.parse(
        Buffer.from(token.split(".")[1], "base64url").toString()
      );
      socket.data.userId = payload.id as string;
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const userId: string = socket.data.userId;
    socket.join(`user:${userId}`);
    console.log(`Socket connected: ${userId}`);

    // --- Channel chat ---
    socket.on("chat:join", ({ channel }: { channel: string }) => {
      socket.join(`channel:${channel}`);
    });

    socket.on("chat:message", async ({ channel, content }: { channel: string; content: string }) => {
      const trimmed = content.trim().slice(0, 500);
      if (!trimmed) return;
      const message = await prisma.chatMessage.create({
        data: { channel, userId, content: trimmed },
        include: { user: { select: { id: true, username: true } } },
      });
      io.to(`channel:${channel}`).emit("chat:message", message);
    });

    // --- Series chat (ephemeral — no DB) ---
    socket.on("series:join", ({ seriesId }: { seriesId: string }) => {
      socket.join(`series:${seriesId}`);
    });

    socket.on("series:chat:send", async ({ seriesId, content }: { seriesId: string; content: string }) => {
      const trimmed = content.trim().slice(0, 500);
      if (!trimmed) return;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, username: true },
      });
      io.to(`series:${seriesId}`).emit("series:chat:message", {
        userId,
        username: user?.username ?? "Unknown",
        content: trimmed,
        timestamp: new Date().toISOString(),
      });
    });

    socket.on("disconnect", async () => {
      await removeFromArena(userId);
      io.emit("arena:leave", { userId });
    });

    socket.on("arena:join", async (data: { format: "BO3" | "BO5"; note?: string }) => {
      await addToArena(userId);
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, username: true, connectCode: true },
      });
      io.emit("arena:join", { user, format: data.format, note: data.note });
    });

    socket.on("arena:leave", async () => {
      await removeFromArena(userId);
      io.emit("arena:leave", { userId });
    });

    socket.on(
      "challenge:send",
      async (data: { challengedId: string; format: "BO3" | "BO5" }) => {
        const challenge = await prisma.challenge.create({
          data: {
            challengerId: userId,
            challengedId: data.challengedId,
            format: data.format,
          },
          include: {
            challenger: { select: { id: true, username: true, connectCode: true } },
          },
        });

        io.to(`user:${data.challengedId}`).emit("challenge:receive", challenge);
      }
    );

    socket.on("challenge:accept", async (data: { challengeId: string }) => {
      const challenge = await prisma.challenge.update({
        where: { id: data.challengeId, challengedId: userId },
        data: { status: "ACCEPTED" },
        include: {
          challenger: { select: { id: true, username: true, connectCode: true } },
          challenged: { select: { id: true, username: true, connectCode: true } },
        },
      });

      const series = await prisma.series.create({
        data: {
          player1Id: challenge.challengerId,
          player2Id: challenge.challengedId,
          format: challenge.format,
        },
      });

      await prisma.challenge.update({
        where: { id: challenge.id },
        data: { seriesId: series.id },
      });

      // Notify both players
      io.to(`user:${challenge.challengerId}`).emit("challenge:accepted", {
        challenge,
        series,
      });
      io.to(`user:${userId}`).emit("challenge:accepted", { challenge, series });
    });

    socket.on("challenge:decline", async (data: { challengeId: string }) => {
      const challenge = await prisma.challenge.update({
        where: { id: data.challengeId, challengedId: userId },
        data: { status: "DECLINED", resolvedAt: new Date() },
      });

      io.to(`user:${challenge.challengerId}`).emit("challenge:declined", {
        challengeId: challenge.id,
      });
    });

    socket.on(
      "series:game_result",
      async (data: { seriesId: string; winnerId: string }) => {
        const series = await prisma.series.findUnique({
          where: { id: data.seriesId },
        });

        if (!series || series.status !== "IN_PROGRESS") return;
        if (series.player1Id !== userId && series.player2Id !== userId) return;

        const isP1Winner = data.winnerId === series.player1Id;
        const newP1Wins = series.p1Wins + (isP1Winner ? 1 : 0);
        const newP2Wins = series.p2Wins + (isP1Winner ? 0 : 1);
        const winsNeeded = series.format === "BO5" ? 3 : 2;

        const isComplete =
          newP1Wins >= winsNeeded || newP2Wins >= winsNeeded;

        const updated = await prisma.series.update({
          where: { id: data.seriesId },
          data: {
            p1Wins: newP1Wins,
            p2Wins: newP2Wins,
            status: isComplete ? "COMPLETED" : "IN_PROGRESS",
            winnerId: isComplete ? data.winnerId : undefined,
            completedAt: isComplete ? new Date() : undefined,
          },
        });

        io.to(`user:${series.player1Id}`)
          .to(`user:${series.player2Id}`)
          .emit("series:update", updated);
      }
    );
  });
}
