import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAdmin, requireAuth } from "../plugins/auth";
import { parseReplayBuffer, ParsedReplay } from "../lib/slippi";
import { saveReplayFile } from "../lib/replayStorage";

export type ReplayVerificationStatus =
  | "PENDING"
  | "VERIFIED"
  | "MISMATCH"
  | "MANUAL_REVIEW";

// Pure verification decision (vitest-covered, tests/decideVerification.test.ts):
// map the parsed winner's in-game player name onto the match's two entrants'
// usernames (case-insensitively), then compare against the recorded result.
// Verification only confirms/mismatches/flags — it never decides winners.
//
//   parsed winner name maps to neither entrant (or is null) → MANUAL_REVIEW
//   maps to an entrant, match has no recorded winner yet     → PENDING
//   maps to the recorded winner                              → VERIFIED
//   maps to the other entrant                                → MISMATCH
export function decideVerification(
  parsedWinnerName: string | null,
  p1Username: string | null,
  p2Username: string | null,
  p1Id: string,
  p2Id: string,
  recordedWinnerId: string | null
): ReplayVerificationStatus {
  const norm = (name: string | null) => name?.toUpperCase() ?? null;
  const winnerName = norm(parsedWinnerName);

  const parsedWinnerId =
    winnerName !== null && winnerName === norm(p1Username)
      ? p1Id
      : winnerName !== null && winnerName === norm(p2Username)
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
        prisma.user.findUnique({ where: { id: player1Id }, select: { username: true } }),
        prisma.user.findUnique({ where: { id: player2Id }, select: { username: true } }),
      ]);

      // ParsedReplay.winner is the winning player's port; map it to that
      // player's in-game name (null when no winner could be determined).
      const parsedWinnerName =
        parsed.players.find((p) => p.port === parsed.winner)?.playerName ?? null;

      const verification = decideVerification(
        parsedWinnerName,
        p1?.username ?? null,
        p2?.username ?? null,
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
          parsedWinnerName,
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

  // GET /api/replays/reviews/:tournamentId — admin review queue: every
  // replay for the tournament that is not yet VERIFIED (PENDING, MISMATCH,
  // MANUAL_REVIEW), newest first.
  app.get(
    "/reviews/:tournamentId",
    { preHandler: [requireAdmin] },
    async (request) => {
      const { tournamentId } = request.params as { tournamentId: string };
      const replays = await prisma.tournamentReplay.findMany({
        where: { tournamentId, verification: { not: "VERIFIED" } },
        orderBy: { createdAt: "desc" },
      });
      return { replays };
    }
  );

  // PATCH /api/replays/:replayId/resolve — admin resolves a flagged replay:
  // sets the final verification verdict and records who resolved it when.
  app.patch(
    "/:replayId/resolve",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const adminId = (request.user as { id: string }).id;
      const { replayId } = request.params as { replayId: string };
      const schema = z.object({
        verification: z.enum(["VERIFIED", "MISMATCH", "MANUAL_REVIEW"]),
      });
      const body = schema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

      const existing = await prisma.tournamentReplay.findUnique({ where: { id: replayId } });
      if (!existing) return reply.code(404).send({ error: "Replay not found" });

      const replay = await prisma.tournamentReplay.update({
        where: { id: replayId },
        data: {
          verification: body.data.verification,
          resolvedAt: new Date(),
          resolvedById: adminId,
        },
      });
      return { replay };
    }
  );
}
