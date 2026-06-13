/**
 * routes/tournaments.ts — Tournament lifecycle, bracket management, and admin operations.
 *
 * Tournament status lifecycle:
 *   UPCOMING → REGISTRATION → ACTIVE → COMPLETED
 *                           ↘ CANCELED (from UPCOMING or REGISTRATION only)
 *
 * All new admin-created tournaments start in REGISTRATION immediately
 * (not UPCOMING) because there is no automated promotion path from UPCOMING.
 *
 * Endpoints (all under /api/tournaments):
 *   GET  /                              — list all tournaments (public; JWT enriches with viewer state)
 *   GET  /:id                           — full bracket detail (JWT)
 *   POST /:id/register                  — register for a tournament (JWT; free=immediate, paid=Stripe)
 *   POST /                              — create a tournament (ADMIN)
 *   POST /:id/cancel                    — cancel a tournament (ADMIN; UPCOMING/REGISTRATION only)
 *   POST /:id/checkin                   — check in for a tournament (JWT; opens 30 min before start)
 *   POST /:id/start                     — manually start the tournament and generate the bracket (JWT)
 *   GET  /:id/ready                     — matches ready for the authenticated user to play (JWT; heartbeat)
 *   POST /:id/matches/:matchKey/report  — report a match result (participant; JWT)
 *   POST /:id/entries/:userId/dq        — disqualify a player (ADMIN)
 *   POST /:id/matches/:matchKey/override — TO override for a stuck match (ADMIN)
 *
 * Paid tournaments (entryFee > 0) are feature-flagged behind PAID_EVENTS_ENABLED=true
 * and use Stripe Checkout (mode: "payment"). Entry is confirmed by the webhook
 * handler in routes/webhooks.ts, not by the registration response.
 *
 * Prize split constants (PRIZE_SPLIT) are exported for reference from other modules.
 *
 * /ready doubles as a liveness heartbeat: each poll calls markPresent() so the
 * no-show sweep knows who is actually present. This is fire-and-forget and must
 * never add latency to the poll response.
 */
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAdmin, requireAuth } from "../plugins/auth";
import { stripe } from "../lib/stripe";
import {
  checkinWindowOpen,
  dqTournamentEntry,
  getReadyTournamentMatches,
  reportTournamentResult,
  startTournament,
} from "../lib/bracketService";
import { emitTournamentUpdate } from "../lib/tournamentEvents";
import { markPresent } from "../lib/presence";

// Prize distribution (must sum to 100)
export const PRIZE_SPLIT = { first: 50, second: 25, third: 10, platform: 15 };

// Paid (entry-fee) events are feature-flagged off until the payout flow
// ships. Checked at request time so tests/ops can flip it without reload.
export function paidEventsEnabled(): boolean {
  return process.env.PAID_EVENTS_ENABLED === "true";
}

export async function tournamentRoutes(app: FastifyInstance) {
  /**
   * GET /api/tournaments
   * Auth: public (JWT is optional; if present, the response is enriched).
   * Response 200: Tournament[] (ordered by scheduledAt asc). Each entry includes
   *   _count.entries. If a valid JWT is present, each entry also includes:
   *     viewerRegistered: boolean
   *     viewerCheckedIn: boolean
   *     viewerPlacement: number | null
   *   Without a JWT all three fields are false/null.
   * Note: anonymous requests still get the full tournament list; the JWT check
   *   is wrapped in a try/catch so a missing/invalid token is not an error.
   */
  app.get("/", async (request) => {
    let viewerId: string | null = null;
    try {
      await request.jwtVerify();
      viewerId = (request.user as { id: string }).id;
    } catch {
      // anonymous — fine
    }

    const tournaments = await prisma.tournament.findMany({
      orderBy: { scheduledAt: "asc" },
      include: { _count: { select: { entries: true } } },
    });

    if (!viewerId) {
      return tournaments.map((t) => ({
        ...t,
        viewerRegistered: false,
        viewerCheckedIn: false,
        viewerPlacement: null,
      }));
    }
    const myEntries = await prisma.tournamentEntry.findMany({
      where: { userId: viewerId, tournamentId: { in: tournaments.map((t) => t.id) } },
    });
    const byTournament = new Map(myEntries.map((e) => [e.tournamentId, e]));
    return tournaments.map((t) => ({
      ...t,
      viewerRegistered: byTournament.has(t.id),
      viewerCheckedIn: byTournament.get(t.id)?.checkedInAt != null,
      viewerPlacement: byTournament.get(t.id)?.placement ?? null,
    }));
  });

  /**
   * GET /api/tournaments/:id
   * Auth: JWT required.
   * Params: id.
   * Response 200: Tournament with entries[] (each including user { id, username })
   *   and matches[] ordered by [round asc, matchNumber asc], each including series.
   * Response 404: tournament not found.
   */
  app.get("/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const tournament = await prisma.tournament.findUnique({
      where: { id },
      include: {
        entries: {
          include: {
            user: { select: { id: true, username: true } },
          },
        },
        matches: {
          orderBy: [{ round: "asc" }, { matchNumber: "asc" }],
          include: { series: true },
        },
      },
    });
    if (!tournament) return reply.code(404).send({ error: "Tournament not found" });
    return tournament;
  });

  /**
   * POST /api/tournaments/:id/register
   * Auth: JWT required.
   * Params: id.
   * Free tournament (entryFee === 0):
   *   Response 201: { entry: TournamentEntry } (includes user { id, username }).
   *   Side effects: creates TournamentEntry; emits tournament update event.
   * Paid tournament (entryFee > 0, PAID_EVENTS_ENABLED=true):
   *   Response 200: { checkoutUrl: string } — Stripe Checkout URL.
   *   Side effects: creates Stripe Customer if needed; creates Checkout session.
   *   Entry is created by the webhook on checkout.session.completed.
   * Response 400: paid events not yet available (feature flag off).
   * Response 404: tournament or user not found.
   * Response 409: tournament not in REGISTRATION status, tournament full,
   *   or player already registered.
   */
  app.post("/:id/register", { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = (request.user as { id: string }).id;
    const { id } = request.params as { id: string };

    const tournament = await prisma.tournament.findUnique({ where: { id } });
    if (!tournament) return reply.code(404).send({ error: "Tournament not found" });
    if (tournament.status !== "REGISTRATION") {
      return reply.code(409).send({ error: "Tournament is not open for registration" });
    }

    const entryCount = await prisma.tournamentEntry.count({ where: { tournamentId: id } });
    if (entryCount >= tournament.maxEntrants) {
      return reply.code(409).send({ error: "Tournament is full" });
    }

    const alreadyEntered = await prisma.tournamentEntry.findUnique({
      where: { tournamentId_userId: { tournamentId: id, userId } },
    });
    if (alreadyEntered) return reply.code(409).send({ error: "Already registered" });

    // Free tournament — register directly
    if (tournament.entryFee === 0) {
      const entry = await prisma.tournamentEntry.create({
        data: { tournamentId: id, userId },
        include: { user: { select: { id: true, username: true } } },
      });
      emitTournamentUpdate(id, "entry");
      return reply.code(201).send({ entry });
    }

    // Paid tournament — feature-flagged off until payouts ship
    if (!paidEventsEnabled()) {
      return reply.code(400).send({ error: "Paid events are not available yet" });
    }

    // Create Stripe checkout session
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, stripeCustomerId: true },
    });
    if (!user) return reply.code(404).send({ error: "User not found" });

    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email });
      customerId = customer.id;
      await prisma.user.update({ where: { id: userId }, data: { stripeCustomerId: customerId } });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: tournament.entryFee,
            product_data: { name: `${tournament.name} — Entry Fee` },
          },
          quantity: 1,
        },
      ],
      success_url: `${process.env.WEB_URL}/tournaments/success?tournament_id=${id}`,
      cancel_url: `${process.env.WEB_URL}/tournaments`,
      metadata: { type: "tournament_entry", tournamentId: id, userId },
    });

    return { checkoutUrl: session.url };
  });

  /**
   * POST /api/tournaments
   * Auth: ADMIN required.
   * Body: {
   *   name: string (3-100),
   *   description?: string (max 500),
   *   scheduledAt: ISO 8601 datetime string,
   *   format?: "SINGLE_ELIM"|"DOUBLE_ELIM" (default: "SINGLE_ELIM"),
   *   seriesFormat?: "BO3"|"BO5" (default: "BO5"),
   *   maxEntrants?: integer 4-256 (default: 64),
   *   entryFee?: integer cents ≥ 0 (default: 0),
   * }
   * Response 201: the created Tournament row.
   * Response 400: validation error, or entryFee > 0 when PAID_EVENTS_ENABLED is false.
   * Note: status is set to REGISTRATION immediately (not UPCOMING) because
   *   there is no automated promotion path from UPCOMING.
   */
  app.post("/", { preHandler: [requireAdmin] }, async (request, reply) => {
    const schema = z.object({
      name: z.string().min(3).max(100),
      description: z.string().max(500).optional(),
      scheduledAt: z.string().datetime(),
      format: z.enum(["SINGLE_ELIM", "DOUBLE_ELIM"]).default("SINGLE_ELIM"),
      seriesFormat: z.enum(["BO3", "BO5"]).default("BO5"),
      maxEntrants: z.number().int().min(4).max(256).default(64),
      entryFee: z.number().int().min(0).default(0),
    });

    const body = schema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    if (body.data.entryFee > 0 && !paidEventsEnabled()) {
      return reply.code(400).send({ error: "Paid events are not available yet" });
    }

    // Registration opens immediately — the schema default (UPCOMING) has no
    // promotion path, so an admin-created event would otherwise be stuck
    // un-registerable forever (the scheduler sets this explicitly too).
    const tournament = await prisma.tournament.create({
      data: { ...body.data, scheduledAt: new Date(body.data.scheduledAt), status: "REGISTRATION" },
    });

    return reply.code(201).send(tournament);
  });

  /**
   * POST /api/tournaments/:id/cancel
   * Auth: ADMIN required.
   * Params: id.
   * Response 200: { tournament: updatedTournament }
   * Response 404: tournament not found.
   * Response 409: tournament is not in UPCOMING or REGISTRATION status
   *   (started/finished brackets are immutable).
   * Side effects: sets status to CANCELED; emits tournament "canceled" event.
   */
  app.post("/:id/cancel", { preHandler: [requireAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const tournament = await prisma.tournament.findUnique({ where: { id } });
    if (!tournament) return reply.code(404).send({ error: "Tournament not found" });
    if (tournament.status !== "UPCOMING" && tournament.status !== "REGISTRATION") {
      return reply.code(409).send({ error: "Only upcoming/registration tournaments can be canceled" });
    }
    const updated = await prisma.tournament.update({
      where: { id },
      data: { status: "CANCELED" },
    });
    emitTournamentUpdate(id, "canceled");
    return { tournament: updated };
  });

  /**
   * POST /api/tournaments/:id/checkin
   * Auth: JWT required (must be registered for the tournament).
   * Params: id.
   * Response 200: { entry: updatedTournamentEntry } with checkedInAt set.
   * Response 404: tournament not found, or player not registered.
   * Response 409: tournament not in REGISTRATION status, check-in window not
   *   open yet (opens 30 min before scheduledAt), or already checked in.
   * Side effects: sets TournamentEntry.checkedInAt; emits tournament "checkin" event.
   */
  app.post("/:id/checkin", { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = (request.user as { id: string }).id;
    const { id } = request.params as { id: string };

    const tournament = await prisma.tournament.findUnique({ where: { id } });
    if (!tournament) return reply.code(404).send({ error: "Tournament not found" });
    if (tournament.status !== "REGISTRATION") {
      return reply.code(409).send({ error: "Tournament is not accepting check-ins" });
    }
    if (!checkinWindowOpen(tournament.scheduledAt)) {
      return reply.code(409).send({ error: "Check-in has not opened yet" });
    }

    const entry = await prisma.tournamentEntry.findUnique({
      where: { tournamentId_userId: { tournamentId: id, userId } },
    });
    if (!entry) return reply.code(404).send({ error: "Not registered for this tournament" });
    if (entry.checkedInAt) return reply.code(409).send({ error: "Already checked in" });

    const updated = await prisma.tournamentEntry.update({
      where: { id: entry.id },
      data: { checkedInAt: new Date() },
    });
    emitTournamentUpdate(id, "checkin");
    return { entry: updated };
  });

  /**
   * POST /api/tournaments/:id/start
   * Auth: JWT required (no admin check — any authenticated user can trigger;
   *   the bracketService enforces its own invariants).
   * Params: id.
   * Response 200: { started: true }
   * Response 404: tournament not found.
   * Response 409: tournament's scheduledAt is in the future, or bracketService
   *   returns a reason (e.g. insufficient checked-in players).
   * Side effects: closes check-in, seeds bracket via bracketService.startTournament();
   *   emits tournament "started" event.
   * Note: the automated scheduler also calls startTournament() directly at
   *   scheduledAt; this route is for manual/early starts by TOs.
   */
  app.post("/:id/start", { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const tournament = await prisma.tournament.findUnique({ where: { id } });
    if (!tournament) return reply.code(404).send({ error: "Tournament not found" });
    if (new Date() < tournament.scheduledAt) {
      return reply.code(409).send({ error: "Tournament has not reached its scheduled time" });
    }
    const result = await startTournament(id);
    if (!result.started) return reply.code(409).send({ error: result.reason });
    emitTournamentUpdate(id, "started");
    return { started: true };
  });

  /**
   * GET /api/tournaments/:id/ready
   * Auth: JWT required.
   * Params: id.
   * Response 200: { matches: TournamentMatch[] } — only matches where both
   *   player1Id and player2Id are set and involve the authenticated user.
   *   Returns { matches: [] } when the tournament is not ACTIVE.
   * Response 404: tournament not found.
   * Side effects: calls markPresent(tournamentId, userId) fire-and-forget as a
   *   liveness heartbeat. Errors from markPresent are suppressed — presence
   *   must never fail or slow down this poll.
   */
  app.get("/:id/ready", { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = (request.user as { id: string }).id;
    const { id } = request.params as { id: string };
    const tournament = await prisma.tournament.findUnique({ where: { id } });
    if (!tournament) return reply.code(404).send({ error: "Tournament not found" });
    markPresent(id, userId).catch(() => {});
    if (tournament.status !== "ACTIVE") return { matches: [] };
    return { matches: await getReadyTournamentMatches(id, userId) };
  });

  /**
   * POST /api/tournaments/:id/matches/:matchKey/report
   * Auth: JWT required (must be a participant — player1 or player2).
   * Params: id (tournamentId), matchKey.
   * Body: { winnerId: string }
   * Response 200: result from bracketService.reportTournamentResult().
   * Response 400: validation error.
   * Response 403: caller is not a participant.
   * Response 404: tournament or match not found.
   * Response 409: tournament not ACTIVE, result already reported, or
   *   bracketService throws (e.g. bracket integrity violation).
   * Side effects: advances bracket via bracketService; emits tournament
   *   "completed" or "result" event.
   * Trust model (v1): self-reporting by participants; no per-game evidence
   *   required. Disputes go through admin DQ.
   */
  app.post(
    "/:id/matches/:matchKey/report",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = (request.user as { id: string }).id;
      const { id, matchKey } = request.params as { id: string; matchKey: string };
      const schema = z.object({ winnerId: z.string() });
      const body = schema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

      const tournament = await prisma.tournament.findUnique({ where: { id } });
      if (!tournament) return reply.code(404).send({ error: "Tournament not found" });
      if (tournament.status !== "ACTIVE") {
        return reply.code(409).send({ error: "Tournament is not active" });
      }

      const match = await prisma.tournamentMatch.findUnique({
        where: { tournamentId_matchKey: { tournamentId: id, matchKey } },
      });
      if (!match) return reply.code(404).send({ error: "Match not found" });
      if (userId !== match.player1Id && userId !== match.player2Id) {
        return reply.code(403).send({ error: "Only match participants can report" });
      }
      if (match.winnerId) {
        return reply
          .code(409)
          .send({ error: "Result already reported — contact a TO to dispute" });
      }

      try {
        const result = await reportTournamentResult(id, matchKey, body.data.winnerId);
        emitTournamentUpdate(id, result.complete ? "completed" : "result");
        return result;
      } catch (err) {
        return reply.code(409).send({ error: (err as Error).message });
      }
    }
  );

  /**
   * POST /api/tournaments/:id/entries/:userId/dq
   * Auth: ADMIN required.
   * Params: id (tournamentId), userId (player to disqualify).
   * Response 200: { disqualified: true, ...bracketServiceResult }
   * Response 404: tournament or entry not found.
   * Response 409: tournament is COMPLETED or CANCELED, player already DQ'd,
   *   or bracketService throws.
   * Side effects: sets TournamentEntry.dqAt; cascades forfeits for all ready
   *   matches involving the player via bracketService.dqTournamentEntry();
   *   emits tournament "completed" or "result" event.
   */
  app.post(
    "/:id/entries/:userId/dq",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };

      const tournament = await prisma.tournament.findUnique({ where: { id } });
      if (!tournament) return reply.code(404).send({ error: "Tournament not found" });
      if (tournament.status === "COMPLETED" || tournament.status === "CANCELED") {
        return reply.code(409).send({ error: `Tournament is ${tournament.status.toLowerCase()}` });
      }

      const entry = await prisma.tournamentEntry.findUnique({
        where: { tournamentId_userId: { tournamentId: id, userId } },
      });
      if (!entry) return reply.code(404).send({ error: "Player is not entered in this tournament" });
      if (entry.dqAt) return reply.code(409).send({ error: "Player is already disqualified" });

      try {
        const result = await dqTournamentEntry(id, userId);
        emitTournamentUpdate(id, result.complete ? "completed" : "result");
        return { disqualified: true, ...result };
      } catch (err) {
        return reply.code(409).send({ error: (err as Error).message });
      }
    }
  );

  /**
   * POST /api/tournaments/:id/matches/:matchKey/override
   * Auth: ADMIN required.
   * Params: id (tournamentId), matchKey.
   * Body: { winnerId: string }
   * Response 200: result from bracketService.reportTournamentResult().
   * Response 400: validation error.
   * Response 404: tournament or match not found.
   * Response 409: tournament not ACTIVE, result already reported (use DQ instead),
   *   match doesn't have both players yet, or bracketService throws.
   * Side effects: same as /report — advances bracket, emits event.
   * Use case: a TO resolves a stuck match (both players seeded but neither reported).
   */
  app.post(
    "/:id/matches/:matchKey/override",
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { id, matchKey } = request.params as { id: string; matchKey: string };
      const schema = z.object({ winnerId: z.string() });
      const body = schema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

      const tournament = await prisma.tournament.findUnique({ where: { id } });
      if (!tournament) return reply.code(404).send({ error: "Tournament not found" });
      if (tournament.status !== "ACTIVE") {
        return reply.code(409).send({ error: "Tournament is not active" });
      }

      const match = await prisma.tournamentMatch.findUnique({
        where: { tournamentId_matchKey: { tournamentId: id, matchKey } },
      });
      if (!match) return reply.code(404).send({ error: "Match not found" });
      if (match.winnerId) {
        return reply.code(409).send({
          error: "Result already reported — disqualify the offending player instead",
        });
      }
      if (!match.player1Id || !match.player2Id) {
        return reply.code(409).send({ error: "Match does not have both players yet" });
      }

      try {
        const result = await reportTournamentResult(id, matchKey, body.data.winnerId);
        emitTournamentUpdate(id, result.complete ? "completed" : "result");
        return result;
      } catch (err) {
        return reply.code(409).send({ error: (err as Error).message });
      }
    }
  );
}
