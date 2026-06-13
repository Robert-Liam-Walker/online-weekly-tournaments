/**
 * plugins/socket.ts — Socket.io connection lifecycle and real-time event handlers.
 *
 * Responsibilities:
 *   - JWT authentication middleware for every socket connection (handshake
 *     auth.token, manual base64url decode; see caveat below).
 *   - Per-user room join so routes can address individual clients:
 *       io.to(`user:<id>`)
 *   - Inbound socket events: channel chat, series ephemeral chat, arena
 *     presence, challenge lifecycle, and series game-result reporting.
 *   - Arena cleanup on disconnect (removes player from the Redis set and
 *     broadcasts arena:leave to all clients).
 *
 * Module-level singleton (getIO) exists so lib/ helpers can emit without
 * importing src/index.ts, which would create a circular dependency.
 *
 * Inbound events handled here:
 *   chat:join             { channel }         — subscribe to a channel room
 *   chat:message          { channel, content } — persist + broadcast (≤500 chars)
 *   series:join           { seriesId }         — subscribe to a series room
 *   series:chat:send      { seriesId, content } — ephemeral series chat (no DB)
 *   arena:join            { format, note? }    — add self to arena presence
 *   arena:leave           (no payload)         — remove self from arena presence
 *   challenge:send        { challengedId, format } — create Challenge row + notify target
 *   challenge:accept      { challengeId }      — accept + create Series, notify both
 *   challenge:decline     { challengeId }      — decline, notify challenger
 *   series:game_result    { seriesId, winnerId } — report a game result, update series
 *
 * CAVEAT: The JWT middleware does a manual base64url decode instead of using
 * @fastify/jwt (which is bound to FastifyRequest). This means token signature
 * verification is SKIPPED for socket connections — any base64url payload with
 * an `id` field is accepted. This is a known gap (see TODO below).
 */
import { Server, Socket } from "socket.io";
import { prisma } from "../lib/prisma";
import { addToArena, removeFromArena } from "../lib/redis";

// Held here so libs/routes can emit without importing src/index.ts (cycle).
let ioInstance: Server | null = null;

/** The live Socket.io server, or null before registerSocketHandlers runs. */
export function getIO(): Server | null {
  return ioInstance;
}

/**
 * Wire up all Socket.io middleware and event handlers.
 * Must be called once after the Server is created (called from src/index.ts).
 * Stores the server reference in the module-level singleton for getIO().
 *
 * @param io - The Socket.io Server instance shared with the HTTP server.
 */
export function registerSocketHandlers(io: Server) {
  ioInstance = io;
  io.use(async (socket, next) => {
    // Validate JWT from handshake auth.
    // TODO(security): This decodes the JWT payload without verifying the
    // signature — any crafted token with an `id` field will pass. Replace with
    // proper verification using the same JWT_SECRET used by @fastify/jwt.
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error("Missing token"));

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
    // Each user gets a private room so other handlers can address them directly.
    socket.join(`user:${userId}`);
    console.log(`Socket connected: ${userId}`);

    // --- Channel chat (persisted) ---

    // Join a named channel room to receive its messages.
    socket.on("chat:join", ({ channel }: { channel: string }) => {
      socket.join(`channel:${channel}`);
    });

    // Persist the message (≤500 chars) and broadcast to all channel subscribers.
    socket.on("chat:message", async ({ channel, content }: { channel: string; content: string }) => {
      const trimmed = content.trim().slice(0, 500);
      if (!trimmed) return;
      const message = await prisma.chatMessage.create({
        data: { channel, userId, content: trimmed },
        include: { user: { select: { id: true, username: true } } },
      });
      io.to(`channel:${channel}`).emit("chat:message", message);
    });

    // --- Series chat (ephemeral — no DB write) ---

    // Subscribe to live series chat for a match in progress.
    socket.on("series:join", ({ seriesId }: { seriesId: string }) => {
      socket.join(`series:${seriesId}`);
    });

    // Broadcast a chat message to series room subscribers without persisting it.
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

    // --- Arena presence ---

    // Remove the player from the arena Redis set and notify all clients on
    // any disconnect, regardless of whether they sent arena:leave explicitly.
    socket.on("disconnect", async () => {
      await removeFromArena(userId);
      io.emit("arena:leave", { userId });
    });

    // Add the player to arena presence and broadcast their entry to everyone.
    socket.on("arena:join", async (data: { format: "BO3" | "BO5"; note?: string }) => {
      await addToArena(userId);
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, username: true },
      });
      io.emit("arena:join", { user, format: data.format, note: data.note });
    });

    // Explicit leave (also handled on disconnect above).
    socket.on("arena:leave", async () => {
      await removeFromArena(userId);
      io.emit("arena:leave", { userId });
    });

    // --- Challenge lifecycle ---

    // Create a Challenge row and notify the challenged player.
    // Note: duplicate-pending guard is NOT enforced here (only in the REST
    // route). Socket-originated challenges bypass the 409 check.
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
            challenger: { select: { id: true, username: true } },
          },
        });

        io.to(`user:${data.challengedId}`).emit("challenge:receive", challenge);
      }
    );

    // Accept a challenge: update its status, create a Series, link them, then
    // notify both the challenger and the accepting user.
    socket.on("challenge:accept", async (data: { challengeId: string }) => {
      const challenge = await prisma.challenge.update({
        where: { id: data.challengeId, challengedId: userId },
        data: { status: "ACCEPTED" },
        include: {
          challenger: { select: { id: true, username: true } },
          challenged: { select: { id: true, username: true } },
        },
      });

      const series = await prisma.series.create({
        data: {
          player1Id: challenge.challengerId,
          player2Id: challenge.challengedId,
          format: challenge.format,
        },
      });

      // Back-link the series onto the challenge (separate update because
      // Prisma doesn't support nested create + connect in the same mutation
      // when the FK is on the parent side).
      await prisma.challenge.update({
        where: { id: challenge.id },
        data: { seriesId: series.id },
      });

      // Notify both players so both can navigate to the series.
      io.to(`user:${challenge.challengerId}`).emit("challenge:accepted", {
        challenge,
        series,
      });
      io.to(`user:${userId}`).emit("challenge:accepted", { challenge, series });
    });

    // Decline a challenge and notify only the challenger.
    socket.on("challenge:decline", async (data: { challengeId: string }) => {
      const challenge = await prisma.challenge.update({
        where: { id: data.challengeId, challengedId: userId },
        data: { status: "DECLINED", resolvedAt: new Date() },
      });

      io.to(`user:${challenge.challengerId}`).emit("challenge:declined", {
        challengeId: challenge.id,
      });
    });

    // --- Series game result (socket path) ---

    // Report a single game result for an in-progress series. Either participant
    // may submit; the series is completed automatically once the win threshold
    // is reached (BO3: 2 wins, BO5: 3 wins). Emits series:update to both players.
    // Note: this path does NOT create a Game row — use PATCH /api/series/:id/score
    // for the REST path that also stores per-game character/stage data.
    socket.on(
      "series:game_result",
      async (data: { seriesId: string; winnerId: string }) => {
        const series = await prisma.series.findUnique({
          where: { id: data.seriesId },
        });

        if (!series || series.status !== "IN_PROGRESS") return;
        // Silently ignore submissions from non-participants.
        if (series.player1Id !== userId && series.player2Id !== userId) return;

        const isP1Winner = data.winnerId === series.player1Id;
        const newP1Wins = series.p1Wins + (isP1Winner ? 1 : 0);
        const newP2Wins = series.p2Wins + (isP1Winner ? 0 : 1);
        // BO3 needs 2 wins; BO5 needs 3.
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
