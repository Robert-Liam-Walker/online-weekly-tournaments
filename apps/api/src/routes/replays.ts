/**
 * routes/replays.ts — Tournament replay upload, review queue, and admin resolution.
 *
 * Replays (.slp files) can be attached to tournament matches as evidence. The
 * server parses each uploaded file with lib/slippi.ts to extract the winner's
 * in-game player name, then cross-checks it against the reported result using
 * decideVerification(). This produces a verification status:
 *
 *   VERIFIED      — parsed winner name matches reported winner username
 *   MISMATCH      — parsed winner name maps to the OTHER player
 *   MANUAL_REVIEW — winner name doesn't map to either player, or is null
 *   PENDING       — winner name maps to a player but no result is recorded yet
 *
 * Admins can override the status via PATCH /:replayId/resolve.
 *
 * Endpoints (under /api/replays):
 *   POST   /:tournamentId/matches/:matchKey/replay   — upload a .slp (participant; JWT)
 *   GET    /:tournamentId/matches/:matchKey/replays  — list replays for a match (JWT)
 *   GET    /reviews/:tournamentId                    — admin review queue (ADMIN)
 *   PATCH  /:replayId/resolve                        — admin resolves a flagged replay (ADMIN)
 *
 * Storage: replay files are stored via lib/replayStorage.ts (S3 in production,
 * local disk in dev). The storagePath is persisted on the TournamentReplay row.
 *
 * decideVerification() is a pure function (vitest-covered in
 * tests/decideVerification.test.ts) so it can be tested without a DB.
 */
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
  /**
   * POST /api/replays/:tournamentId/matches/:matchKey/replay
   * Auth: JWT required (must be a participant of the match — player1 or player2).
   * Params: tournamentId, matchKey.
   * Body: multipart/form-data — single file field (the .slp file; max 50 MB from global config).
   * Response 201: { replay: TournamentReplay }
   * Response 400: no file uploaded.
   * Response 403: caller is not a participant in this match.
   * Response 404: match not found.
   * Response 422: file could not be parsed as a valid .slp, or no players found.
   * Side effects:
   *   - Parses the .slp buffer with lib/slippi.ts.
   *   - Stores the file via lib/replayStorage.ts (S3/local).
   *   - Creates a TournamentReplay row with parsed metadata + verification status.
   */
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

  /**
   * GET /api/replays/:tournamentId/matches/:matchKey/replays
   * Auth: JWT required.
   * Params: tournamentId, matchKey.
   * Response 200: { replays: TournamentReplay[] } (newest first).
   * Response 404: match not found.
   */
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

  /**
   * GET /api/replays/reviews/:tournamentId
   * Auth: ADMIN required.
   * Params: tournamentId.
   * Response 200: { replays: TournamentReplay[] } — all unverified replays
   *   (status is PENDING, MISMATCH, or MANUAL_REVIEW) for the tournament,
   *   newest first.
   */
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

  /**
   * PATCH /api/replays/:replayId/resolve
   * Auth: ADMIN required.
   * Params: replayId.
   * Body: { verification: "VERIFIED" | "MISMATCH" | "MANUAL_REVIEW" }
   * Response 200: { replay: TournamentReplay } with updated verification,
   *   resolvedAt timestamp, and resolvedById (the admin's user id).
   * Response 400: invalid verification value.
   * Response 404: replay not found.
   * Note: PENDING is not a valid target state for resolve — admins must
   *   commit to a final verdict.
   */
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
