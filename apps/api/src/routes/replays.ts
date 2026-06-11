import { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../plugins/auth";
import { parseReplayBuffer, ParsedReplay } from "../lib/slippi";
import { saveReplayFile } from "../lib/replayStorage";

export type ReplayVerificationStatus =
  | "PENDING"
  | "VERIFIED"
  | "MISMATCH"
  | "MANUAL_REVIEW";

// Pure verification decision (vitest-covered, tests/decideVerification.test.ts):
// map the parsed winner's connect code onto the match's two players, then
// compare against the recorded result.
//
//   parsed winner code maps to neither player (or is null) → MANUAL_REVIEW
//   maps to a player, match has no recorded winner yet      → PENDING
//   maps to the recorded winner                              → VERIFIED
//   maps to the other player                                 → MISMATCH
export function decideVerification(
  parsedWinnerCode: string | null,
  p1Code: string | null,
  p2Code: string | null,
  p1Id: string,
  p2Id: string,
  recordedWinnerId: string | null
): ReplayVerificationStatus {
  const norm = (code: string | null) => code?.toUpperCase() ?? null;
  const winnerCode = norm(parsedWinnerCode);

  const parsedWinnerId =
    winnerCode !== null && winnerCode === norm(p1Code)
      ? p1Id
      : winnerCode !== null && winnerCode === norm(p2Code)
      ? p2Id
      : null;

  if (!parsedWinnerId) return "MANUAL_REVIEW";
  if (!recordedWinnerId) return "PENDING";
  return parsedWinnerId === recordedWinnerId ? "VERIFIED" : "MISMATCH";
}

export async function replayRoutes(app: FastifyInstance) {
  // POST /api/replays/:tournamentId/matches/:matchKey/replay — attach a .slp
  // as evidence for a tournament set. Participant-only; parsed server-side
  // and cross-checked against the reported result (roadmap Phase 1 E).
  app.post(
    "/:tournamentId/matches/:matchKey/replay",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = (request.user as { id: string }).id;
      const { tournamentId, matchKey } = request.params as {
        tournamentId: string;
        matchKey: string;
      };

      const match = await prisma.tournamentMatch.findUnique({
        where: { tournamentId_matchKey: { tournamentId, matchKey } },
      });
      if (!match) return reply.code(404).send({ error: "Match not found" });
      if (userId !== match.player1Id && userId !== match.player2Id) {
        return reply.code(403).send({ error: "Only match participants can attach replays" });
      }
      // Participant check passed, so both player ids are decided (and non-null).
      const player1Id = match.player1Id!;
      const player2Id = match.player2Id!;

      const data = await request.file();
      if (!data) return reply.code(400).send({ error: "No file uploaded" });

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      let parsed: ParsedReplay;
      try {
        parsed = parseReplayBuffer(buffer);
      } catch {
        return reply.code(422).send({ error: "Could not parse .slp file" });
      }
      if (parsed.players.length === 0) {
        return reply.code(422).send({ error: "Not a valid Slippi replay (no players found)" });
      }

      const [p1, p2] = await Promise.all([
        prisma.user.findUnique({ where: { id: player1Id }, select: { connectCode: true } }),
        prisma.user.findUnique({ where: { id: player2Id }, select: { connectCode: true } }),
      ]);

      // ParsedReplay.winner is the winning player's port; map it to that
      // player's connect code (null when no winner could be determined).
      const parsedWinnerCode =
        parsed.players.find((p) => p.port === parsed.winner)?.connectCode ?? null;

      const verification = decideVerification(
        parsedWinnerCode,
        p1?.connectCode ?? null,
        p2?.connectCode ?? null,
        player1Id,
        player2Id,
        match.winnerId
      );

      const stored = await saveReplayFile(tournamentId, matchKey, buffer);

      const replay = await prisma.tournamentReplay.create({
        data: {
          tournamentId,
          matchKey,
          uploaderId: userId,
          fileName: data.filename || "replay.slp",
          storagePath: stored.storagePath,
          stage: parsed.stage,
          durationFrames: parsed.durationFrames,
          parsedWinnerCode,
          verification,
        },
      });

      return reply.code(201).send({ replay });
    }
  );

  // GET /api/replays/:tournamentId/matches/:matchKey/replays — list the
  // replays attached to a set (newest first).
  app.get(
    "/:tournamentId/matches/:matchKey/replays",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { tournamentId, matchKey } = request.params as {
        tournamentId: string;
        matchKey: string;
      };

      const match = await prisma.tournamentMatch.findUnique({
        where: { tournamentId_matchKey: { tournamentId, matchKey } },
      });
      if (!match) return reply.code(404).send({ error: "Match not found" });

      const replays = await prisma.tournamentReplay.findMany({
        where: { tournamentId, matchKey },
        orderBy: { createdAt: "desc" },
      });
      return { replays };
    }
  );
}
