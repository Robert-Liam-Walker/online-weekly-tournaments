import cron from "node-cron";
import { prisma } from "./prisma";
import { startTournament, sweepNoShows } from "./bracketService";
import { emitTournamentUpdate } from "./tournamentEvents";
import { REGIONS, nextNightAt, regionDateLabel } from "./regions";

/**
 * Randall's Nightly Tournaments: every night, ONE free event per region
 * (EU / NA East / NA West) at 20:00 region-local — DST-correct via
 * lib/regions.ts. Events are stored as absolute UTC instants; clients
 * render region-local + viewer-local times.
 *
 * Idempotency: the scheduler computes each region's next 20:00-local
 * instant deterministically, so "(region, scheduledAt) already exists"
 * is an exact-match check — re-runs and multi-instance races can only
 * ever find-or-create the same row. (No unique constraint needed; the
 * worst race outcome is a transient duplicate that the exact-match check
 * prevents in practice since the cron is single-instance today.)
 *
 * Release scope is FREE-ONLY (Stripe dormant): the nightly scheduler
 * creates no paid events at all. Paid creation remains possible only via
 * the admin route behind PAID_EVENTS_ENABLED.
 */
export async function ensureNightlyTournaments(now: Date = new Date()) {
  for (const region of REGIONS) {
    const scheduledAt = nextNightAt(region, now);
    const existing = await prisma.tournament.findFirst({
      where: { region: region.code, scheduledAt },
    });
    if (existing) continue;

    const label = regionDateLabel(scheduledAt, region.tz);
    await prisma.tournament.create({
      data: {
        name: `Randalls Nightly — ${region.label} — ${label}`,
        description:
          "Free entry, open to all. 32-player double elimination, best of 3. Check in within 30 minutes of start.",
        scheduledAt,
        region: region.code,
        format: "DOUBLE_ELIM",
        seriesFormat: "BO3",
        maxEntrants: 32,
        entryFee: 0,
        status: "REGISTRATION",
      },
    });
    console.log(
      `[scheduler] Created Randalls Nightly — ${region.label} — ${label} (${scheduledAt.toISOString()}).`
    );
  }
}

/** Start (or cancel) any tournament whose scheduled time has arrived */
export async function startDueTournaments() {
  const due = await prisma.tournament.findMany({
    where: { status: "REGISTRATION", scheduledAt: { lte: new Date() } },
  });
  for (const t of due) {
    const result = await startTournament(t.id);
    if (result.started) emitTournamentUpdate(t.id, "started");
    console.log(
      `[scheduler] ${t.name}: ${result.started ? "started" : `not started (${result.reason})`}`
    );
  }
}

/**
 * Minutes a ready match may sit before absent players are auto-DQ'd.
 * READY_TIMEOUT_MINUTES env, default 10; "0" disables the no-show sweep.
 * Read at call time so tests/ops can flip it without reload (same pattern
 * as paidEventsEnabled).
 */
export function readyTimeoutMinutes(): number {
  const raw = process.env.READY_TIMEOUT_MINUTES ?? "10";
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10;
}

/** Auto-DQ no-shows in every ACTIVE tournament (no-op when disabled). */
export async function sweepNoShowTournaments() {
  const timeoutMinutes = readyTimeoutMinutes();
  if (timeoutMinutes <= 0) return;

  const active = await prisma.tournament.findMany({ where: { status: "ACTIVE" } });
  for (const t of active) {
    try {
      const result = await sweepNoShows(t.id, timeoutMinutes);
      if (result.dqd.length > 0) {
        emitTournamentUpdate(t.id, result.complete ? "completed" : "result");
        console.log(
          `[scheduler] ${t.name}: no-show sweep DQ'd ${result.dqd.length} player(s), ` +
            `${result.forfeits} forfeit(s)${result.complete ? ", tournament completed" : ""}`
        );
      }
    } catch (err) {
      // Per-tournament isolation: a busy lock (players actively reporting)
      // must not block sweeps of the remaining tournaments.
      console.error(`[scheduler] ${t.name}: no-show sweep failed`, err);
    }
  }
}

/** Boot + per-minute loop: ensure tonight's regionals exist, start due
 *  tournaments (close check-in, generate brackets), auto-DQ no-shows. */
export function startTournamentScheduler() {
  ensureNightlyTournaments().catch(console.error);

  cron.schedule("* * * * *", async () => {
    await ensureNightlyTournaments().catch(console.error); // cheap + idempotent
    await startDueTournaments().catch(console.error);
    await sweepNoShowTournaments().catch(console.error);
  });

  console.log(
    "[scheduler] Nightly scheduler started (3 regional events/night at 20:00 local; due-start + no-show sweep every minute)."
  );
}
