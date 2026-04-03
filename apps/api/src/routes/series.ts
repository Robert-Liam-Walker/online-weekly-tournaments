import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../plugins/auth";
import { parseReplayBuffer } from "../lib/slippi";
import { io } from "../index";

export async function seriesRoutes(app: FastifyInstance) {
  // GET /api/series/:id
  app.get("/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const series = await prisma.series.findUnique({
      where: { id },
      include: {
        player1: { select: { id: true, username: true, connectCode: true } },
        player2: { select: { id: true, username: true, connectCode: true } },
        games: true,
      },
    });
    if (!series) return reply.code(404).send({ error: "Series not found" });
    return series;
  });

  // PATCH /api/series/:id/score — report a game result
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

  // POST /api/series/:id/replay — upload .slp file for verification
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

      // Verify connect codes match participants
      const p1 = await prisma.user.findUnique({
        where: { id: series.player1Id },
        select: { connectCode: true },
      });
      const p2 = await prisma.user.findUnique({
        where: { id: series.player2Id },
        select: { connectCode: true },
      });

      const replayCodes = parsed.players.map((p) => p.connectCode?.toUpperCase());
      const matchesBothPlayers =
        replayCodes.includes(p1?.connectCode?.toUpperCase() ?? "") &&
        replayCodes.includes(p2?.connectCode?.toUpperCase() ?? "");

      if (!matchesBothPlayers) {
        return reply
          .code(422)
          .send({ error: "Replay connect codes do not match series participants" });
      }

      // Map winner port → connect code → player id
      const winnerPort = parsed.winner;
      const winnerCode = parsed.players
        .find((p) => p.port === winnerPort)
        ?.connectCode?.toUpperCase();

      if (!winnerCode) {
        return reply.code(422).send({ error: "Could not determine winner from replay" });
      }

      const winnerId =
        winnerCode === p1?.connectCode?.toUpperCase()
          ? series.player1Id
          : winnerCode === p2?.connectCode?.toUpperCase()
          ? series.player2Id
          : null;

      if (!winnerId) {
        return reply.code(422).send({ error: "Winner connect code does not match either player" });
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
              p1Character: parsed.players.find((p) => p.connectCode?.toUpperCase() === p1?.connectCode?.toUpperCase())?.characterId ?? undefined,
              p2Character: parsed.players.find((p) => p.connectCode?.toUpperCase() === p2?.connectCode?.toUpperCase())?.characterId ?? undefined,
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
