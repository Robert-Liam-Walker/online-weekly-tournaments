/**
 * routes/series.ts — Series state management and per-game result reporting.
 *
 * A Series represents a BO3 or BO5 match between two players. Series are
 * created by accepting a challenge (routes/challenges.ts) or via the socket
 * event challenge:accept (plugins/socket.ts). Either participant can report
 * game results; the series completes automatically when one player reaches the
 * win threshold (BO3: 2, BO5: 3).
 *
 * Two reporting paths exist:
 *   PATCH /:id/score  — manual report (method + character + stage data optional)
 *   POST  /:id/replay — upload a .slp file; server parses winner automatically
 *
 * Both paths create a Game row and update the Series win counters atomically,
 * then emit series:update to both players via Socket.io.
 *
 * Endpoints (all under /api/series):
 *   GET   /:id          — fetch series with players and game history (JWT)
 *   PATCH /:id/score    — report a game result manually (participant; JWT)
 *   POST  /:id/replay   — upload .slp and auto-report result (participant; JWT)
 *
 * Socket.io events emitted:
 *   series:update { ...Series, player1, player2 }
 *       → emitted to both `user:<player1Id>` and `user:<player2Id>` on score
 *         or replay submission.
 */
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../plugins/auth";
import { parseReplayBuffer } from "../lib/slippi";
import { io } from "../index";

export async function seriesRoutes(app: FastifyInstance) {
  /**
   * GET /api/series/:id
   * Auth: JWT required (any authenticated user can view; not restricted to participants).
   * Params: id — series id.
   * Response 200: Series with player1 { id, username }, player2 { id, username },
   *   and games[] (all Game rows for this series).
   * Response 404: series not found.
   */
  app.get("/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const series = await prisma.series.findUnique({
      where: { id },
      include: {
        player1: { select: { id: true, username: true } },
        player2: { select: { id: true, username: true } },
        games: true,
      },
    });
    if (!series) return reply.code(404).send({ error: "Series not found" });
    return series;
  });

  /**
   * PATCH /api/series/:id/score
   * Auth: JWT required (must be a participant — player1 or player2).
   * Params: id — series id.
   * Body: {
   *   winnerId: string,
   *   p1Character?: number,  — Slippi character id for player 1
   *   p2Character?: number,  — Slippi character id for player 2
   *   stageId?: number,      — Slippi stage id
   * }
   * Response 200: { series: updatedSeries, game: createdGame }
   *   Series includes player1 + player2 { id, username }.
   * Response 400: validation error.
   * Response 403: caller is not a participant.
   * Response 404: series not found.
   * Response 409: series is not IN_PROGRESS.
   * Side effects (atomic transaction):
   *   - Creates a Game row (gameNumber = total games played after this one).
   *   - Updates Series win counters; marks COMPLETED + sets winnerId/completedAt
   *     if the win threshold is reached.
   *   - Emits series:update to both players' Socket.io rooms.
   */
  app.patch(
    "/:id/score",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = (request.user as { id: string }).id;
      const { id } = request.params as { id: string };

      const schema = z.object({
        winnerId: z.string(),
        p1Character: z.number().optional(),
        p2Character: z.number().optional(),
        stageId: z.number().optional(),
      });

      const body = schema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: body.error.flatten() });
      }

      const series = await prisma.series.findUnique({ where: { id } });
      if (!series) return reply.code(404).send({ error: "Series not found" });
      if (series.player1Id !== userId && series.player2Id !== userId) {
        return reply.code(403).send({ error: "Not a participant" });
      }
      if (series.status !== "IN_PROGRESS") {
        return reply.code(409).send({ error: "Series is not in progress" });
      }

      const isP1Winner = body.data.winnerId === series.player1Id;
      const newP1Wins = series.p1Wins + (isP1Winner ? 1 : 0);
      const newP2Wins = series.p2Wins + (isP1Winner ? 0 : 1);
      const winsNeeded = series.format === "BO5" ? 3 : 2;
      const isComplete = newP1Wins >= winsNeeded || newP2Wins >= winsNeeded;

      const gameNumber = newP1Wins + newP2Wins;

      const [game, updatedSeries] = await prisma.$transaction([
        prisma.game.create({
          data: {
            seriesId: id,
            gameNumber,
            winnerId: body.data.winnerId,
            p1Character: body.data.p1Character,
            p2Character: body.data.p2Character,
            stageId: body.data.stageId,
          },
        }),
        prisma.series.update({
          where: { id },
          data: {
            p1Wins: newP1Wins,
            p2Wins: newP2Wins,
            status: isComplete ? "COMPLETED" : "IN_PROGRESS",
            winnerId: isComplete ? body.data.winnerId : undefined,
            completedAt: isComplete ? new Date() : undefined,
          },
          include: {
            player1: { select: { id: true, username: true } },
            player2: { select: { id: true, username: true } },
          },
        }),
      ]);

      io.to(`user:${series.player1Id}`)
        .to(`user:${series.player2Id}`)
        .emit("series:update", updatedSeries);

      return { series: updatedSeries, game };
    }
  );

  /**
   * POST /api/series/:id/replay
   * Auth: JWT required (must be a participant).
   * Params: id — series id.
   * Body: multipart/form-data — single .slp file (max 50 MB from global config).
   * Response 200: { verified: true, series?: updatedSeries }
   *   series is included only when the series was IN_PROGRESS and this game
   *   advanced (or completed) it; absent when already completed.
   * Response 400: no file uploaded.
   * Response 403: caller is not a participant.
   * Response 404: series not found.
   * Response 422: replay player names don't match participants, winner
   *   can't be determined, or winner doesn't map to either player.
   * Side effects (when series is IN_PROGRESS, atomic transaction):
   *   - Creates a Game row with character/stage/duration parsed from the .slp.
   *   - Updates Series win counters (same logic as PATCH /:id/score).
   *   - Emits series:update to both players' rooms.
   * Note: this route does NOT persist the .slp file to storage — unlike the
   *   tournament replay route (routes/replays.ts), which calls saveReplayFile().
   */
  app.post(
    "/:id/replay",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = (request.user as { id: string }).id;
      const { id } = request.params as { id: string };

      const series = await prisma.series.findUnique({ where: { id } });
      if (!series) return reply.code(404).send({ error: "Series not found" });
      if (series.player1Id !== userId && series.player2Id !== userId) {
        return reply.code(403).send({ error: "Not a participant" });
      }

      const data = await request.file();
      if (!data) return reply.code(400).send({ error: "No file uploaded" });

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      const parsed = parseReplayBuffer(buffer);

      // Verify in-game player names match participants' usernames
      const p1 = await prisma.user.findUnique({
        where: { id: series.player1Id },
        select: { username: true },
      });
      const p2 = await prisma.user.findUnique({
        where: { id: series.player2Id },
        select: { username: true },
      });

      const replayNames = parsed.players.map((p) => p.playerName?.toUpperCase());
      const matchesBothPlayers =
        replayNames.includes(p1?.username?.toUpperCase() ?? "") &&
        replayNames.includes(p2?.username?.toUpperCase() ?? "");

      if (!matchesBothPlayers) {
        return reply
          .code(422)
          .send({ error: "Replay player names do not match series participants" });
      }

      // Map winner port → player name → player id
      const winnerPort = parsed.winner;
      const winnerName = parsed.players
        .find((p) => p.port === winnerPort)
        ?.playerName?.toUpperCase();

      if (!winnerName) {
        return reply.code(422).send({ error: "Could not determine winner from replay" });
      }

      const winnerId =
        winnerName === p1?.username?.toUpperCase()
          ? series.player1Id
          : winnerName === p2?.username?.toUpperCase()
          ? series.player2Id
          : null;

      if (!winnerId) {
        return reply.code(422).send({ error: "Winner player name does not match either player" });
      }

      // Record game result (same logic as PATCH /:id/score)
      if (series.status === "IN_PROGRESS") {
        const isP1Winner = winnerId === series.player1Id;
        const newP1Wins = series.p1Wins + (isP1Winner ? 1 : 0);
        const newP2Wins = series.p2Wins + (isP1Winner ? 0 : 1);
        const winsNeeded = series.format === "BO5" ? 3 : 2;
        const isComplete = newP1Wins >= winsNeeded || newP2Wins >= winsNeeded;
        const gameNumber = newP1Wins + newP2Wins;

        const [, updatedSeries] = await prisma.$transaction([
          prisma.game.create({
            data: {
              seriesId: series.id,
              gameNumber,
              winnerId,
              p1Character: parsed.players.find((p) => p.playerName?.toUpperCase() === p1?.username?.toUpperCase())?.characterId ?? undefined,
              p2Character: parsed.players.find((p) => p.playerName?.toUpperCase() === p2?.username?.toUpperCase())?.characterId ?? undefined,
              stageId: parsed.stage ?? undefined,
              duration: parsed.durationFrames ?? undefined,
            },
          }),
          prisma.series.update({
            where: { id: series.id },
            data: {
              p1Wins: newP1Wins,
              p2Wins: newP2Wins,
              status: isComplete ? "COMPLETED" : "IN_PROGRESS",
              winnerId: isComplete ? winnerId : undefined,
              completedAt: isComplete ? new Date() : undefined,
            },
            include: {
              player1: { select: { id: true, username: true } },
              player2: { select: { id: true, username: true } },
            },
          }),
        ]);

        io.to(`user:${series.player1Id}`)
          .to(`user:${series.player2Id}`)
          .emit("series:update", updatedSeries);

        return { verified: true, series: updatedSeries };
      }

      return { verified: true };
    }
  );
}
