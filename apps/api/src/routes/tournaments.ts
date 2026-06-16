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
import { generateDoubleElim } from "@foxtrot/shared";
import { entrantName } from "../lib/displayName";

/**
 * Registration-time preview bracket: seed the CURRENT registrants into a
 * double-elim bracket in memory (NOT persisted) so the in-game bracket fills
 * and grows as people register. Unfilled slots (byes / undecided) are null.
 * Seeds by the same ordering startTournament uses ([seed asc, createdAt asc]);
 * no new sort. Zero registrants → []. Bracket size grows with the count
 * (generateDoubleElim pads to the next power of 2 at or above it, min 4).
 */
function buildPreviewBracket(
  entries: {
    userId: string;
    seed: number | null;
    createdAt: Date;
    dqAt: Date | null;
    user: { id: string; username: string; displayName: string | null };
  }[],
  viewerId: string | null
) {
  const ordered = entries
    .filter((e) => e.dqAt == null)
    .sort(
      (a, b) =>
        (a.seed ?? Number.MAX_SAFE_INTEGER) - (b.seed ?? Number.MAX_SAFE_INTEGER) ||
        a.createdAt.getTime() - b.createdAt.getTime()
    );
  if (ordered.length === 0) return [];
  // GUEST numbers follow REGISTRATION order (createdAt), so they stay stable even
  // after seeding reorders the bracket. Custom names override.
  const registrationOrder = new Map(
    [...ordered]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((e, i) => [e.userId, i + 1])
  );
  const nameById = new Map(
    ordered.map((e) => [e.userId, entrantName(e.user.displayName, registrationOrder.get(e.userId) ?? 1)])
  );
  const bracket = generateDoubleElim(ordered.map((e) => e.userId));
  const out = [];
  for (const m of bracket.matches.values()) {
    const p1 = m.p1 ?? null;
    const p2 = m.p2 ?? null;
    out.push({
      matchKey: m.def.key,
      round: m.def.round,
      matchNumber: m.def.matchNumber,
      player1: p1 ? { id: p1, username: nameById.get(p1) ?? "?" } : null,
      player2: p2 ? { id: p2, username: nameById.get(p2) ?? "?" } : null,
      winnerId: m.winnerId ?? null,
      viewerCurrent:
        m.winnerId == null && p1 != null && p2 != null && (p1 === viewerId || p2 === viewerId),
    });
  }
  return out;
}

// Prize distribution (must sum to 100)
export const PRIZE_SPLIT = { first: 50, second: 25, third: 10, platform: 15 };

// Paid (entry-fee) events are feature-flagged off until the payout flow
// ships. Checked at request time so tests/ops can flip it without reload.
export function paidEventsEnabled(): boolean {
  return process.env.PAID_EVENTS_ENABLED === "true";
}

export async function tournamentRoutes(app: FastifyInstance) {
  // GET /api/tournaments — list all. Public; if a JWT is supplied the
  // response includes the viewer's registration/check-in state per event
  // (the game client relies on this).
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
    // The viewer's own in-game identity, echoed on every row so the Dolphin
    // client picks up a web name change on its next poll (no extra request).
    // Custom name if set; otherwise GUEST + their registration order in that
    // tournament (so a guest only has a name where they're registered).
    const me = await prisma.user.findUnique({
      where: { id: viewerId },
      select: { displayName: true },
    });
    const orderByTournament = new Map<string, number>();
    await Promise.all(
      myEntries.map(async (e) => {
        const before = await prisma.tournamentEntry.count({
          where: { tournamentId: e.tournamentId, createdAt: { lt: e.createdAt } },
        });
        orderByTournament.set(e.tournamentId, before + 1);
      })
    );
    return tournaments.map((t) => {
      const registered = byTournament.has(t.id);
      const viewerDisplayName = me?.displayName
        ? me.displayName
        : registered
          ? entrantName(null, orderByTournament.get(t.id) ?? 1)
          : null;
      return {
        ...t,
        viewerRegistered: registered,
        viewerCheckedIn: byTournament.get(t.id)?.checkedInAt != null,
        viewerPlacement: byTournament.get(t.id)?.placement ?? null,
        viewerDisplayName,
      };
    });
  });

  // GET /api/tournaments/leaderboard — public all-time champions board.
  // Counts tournament wins (placement === 1) from COMPLETED events per user,
  // descending. (Static route; registered before "/:id" for clarity.)
  app.get("/leaderboard", async () => {
    const grouped = await prisma.tournamentEntry.groupBy({
      by: ["userId"],
      where: { placement: 1, tournament: { status: "COMPLETED" } },
      _count: { userId: true },
    });
    if (grouped.length === 0) return { leaders: [] };

    const users = await prisma.user.findMany({
      where: { id: { in: grouped.map((g) => g.userId) } },
      select: { id: true, username: true, displayName: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.displayName ?? u.username]));

    const leaders = grouped
      .map((g) => ({
        userId: g.userId,
        username: nameById.get(g.userId) ?? "???",
        wins: g._count.userId,
      }))
      // Most wins first; ties broken alphabetically for a stable order.
      .sort((a, b) => b.wins - a.wins || a.username.localeCompare(b.username));

    return { leaders };
  });

  // GET /api/tournaments/:id — full bracket detail. Public so the bracket is
  // viewable by logged-out visitors; a JWT (when supplied) adds viewer-aware
  // flags (current match, registration preview perspective).
  app.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    let viewerId: string | null = null;
    try {
      await request.jwtVerify();
      viewerId = (request.user as { id: string }).id;
    } catch {
      // anonymous — fine
    }
    const tournament = await prisma.tournament.findUnique({
      where: { id },
      include: {
        entries: {
          include: {
            user: { select: { id: true, username: true, displayName: true } },
          },
        },
        matches: {
          orderBy: [{ round: "asc" }, { matchNumber: "asc" }],
          include: { series: true },
        },
      },
    });
    if (!tournament) return reply.code(404).send({ error: "Tournament not found" });
    // Flag the viewer's current match: undecided, both players assigned, viewer in it.
    const matches = tournament.matches.map((m) => ({
      ...m,
      viewerCurrent:
        m.winnerId == null &&
        m.player1Id != null &&
        m.player2Id != null &&
        (m.player1Id === viewerId || m.player2Id === viewerId),
    }));
    // Resolve each entrant's shown name: their custom name, else GUEST + their
    // registration order (createdAt). The game reads entry.entrantName.
    const registrationOrder = new Map(
      [...tournament.entries]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((e, i) => [e.userId, i + 1])
    );
    const entries = tournament.entries.map((e) => ({
      ...e,
      entrantName: entrantName(e.user.displayName, registrationOrder.get(e.userId) ?? 1),
    }));
    // Before the bracket is generated (REGISTRATION), serve an in-memory preview
    // built from the current registrants so the bracket fills as people join.
    const previewBracket =
      tournament.status === "REGISTRATION"
        ? buildPreviewBracket(tournament.entries, viewerId)
        : undefined;
    return { ...tournament, entries, matches, previewBracket };
  });

  // POST /api/tournaments/:id/register
  // Free tournament → register immediately
  // Paid tournament → return Stripe checkout URL; entry created by webhook
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

    // Free tournament — register directly. Registration grants the right to
    // play (auto-checked-in); a no-show is handled by the no-show sweep, which
    // gives the opponent the bye. There is no separate check-in step.
    if (tournament.entryFee === 0) {
      const entry = await prisma.tournamentEntry.create({
        data: { tournamentId: id, userId, checkedInAt: new Date() },
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

  // POST /api/tournaments/:id/unregister — drop out while still in registration
  app.post("/:id/unregister", { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = (request.user as { id: string }).id;
    const { id } = request.params as { id: string };

    const tournament = await prisma.tournament.findUnique({ where: { id } });
    if (!tournament) return reply.code(404).send({ error: "Tournament not found" });
    if (tournament.status !== "REGISTRATION") {
      return reply.code(409).send({ error: "Tournament is not open for registration" });
    }

    const entry = await prisma.tournamentEntry.findUnique({
      where: { tournamentId_userId: { tournamentId: id, userId } },
    });
    if (!entry) return reply.code(404).send({ error: "Not registered for this tournament" });

    await prisma.tournamentEntry.delete({
      where: { tournamentId_userId: { tournamentId: id, userId } },
    });
    emitTournamentUpdate(id, "entry");
    return reply.code(200).send({ ok: true });
  });

  // POST /api/tournaments — create tournament (admins only)
  app.post("/", { preHandler: [requireAdmin] }, async (request, reply) => {
    const schema = z.object({
      name: z.string().min(3).max(100),
      description: z.string().max(500).optional(),
      scheduledAt: z.string().datetime(),
      format: z.enum(["SINGLE_ELIM", "DOUBLE_ELIM"]).default("SINGLE_ELIM"),
      seriesFormat: z.enum(["BO3", "BO5"]).default("BO5"),
      maxEntrants: z.number().int().min(4).max(16).default(16), // 16-man cap for now (keeps bracket text large + the text arena safe); raise later
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

  // POST /api/tournaments/:id/cancel — TO action. Only events that haven't
  // produced results can be canceled; started/finished brackets are immutable.
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

  // POST /api/tournaments/:id/checkin — opens 30 min before scheduledAt
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

  // POST /api/tournaments/:id/start — close check-in and generate the bracket.
  // The scheduler calls the service directly; this route covers manual starts.
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

  // GET /api/tournaments/:id/ready — matches with both players decided.
  // The game client polls this every ~5s while the player sits in the lobby,
  // so each authenticated poll doubles as a liveness heartbeat for the
  // no-show sweep. Fire-and-forget: presence must never add latency to or
  // fail the poll itself.
  app.get("/:id/ready", { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = (request.user as { id: string }).id;
    const { id } = request.params as { id: string };
    const tournament = await prisma.tournament.findUnique({ where: { id } });
    if (!tournament) return reply.code(404).send({ error: "Tournament not found" });
    markPresent(id, userId).catch(() => {});
    if (tournament.status !== "ACTIVE") return { matches: [] };
    return { matches: await getReadyTournamentMatches(id, userId) };
  });

  // POST /api/tournaments/:id/matches/:matchKey/report — record a result.
  // v1 trust model: the reporter must be one of the two participants.
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

  // POST /api/tournaments/:id/entries/:userId/dq — disqualify a player (TO
  // action). Before the start the entry is simply excluded from the bracket;
  // mid-bracket every ready match involving the player is forfeited to the
  // opponent (cascading as the player drops through losers).
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

  // POST /api/tournaments/:id/matches/:matchKey/override — TO resolves a
  // stuck match (both players known, neither reported). Already-reported
  // results cannot be overridden — disputes go through DQ instead.
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
