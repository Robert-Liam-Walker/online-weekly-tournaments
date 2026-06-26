import { prisma } from "./prisma";
import { startTournament, sweepNoShows } from "./bracketService";
import { emitTournamentUpdate } from "./tournamentEvents";
import { REGIONS, nextWeeklyAt, regionDateLabel } from "./regions";

/**
 * Online Weekly Tournament Series: every Friday, ONE free United States event
 * at 20:00 US-Eastern — DST-correct via lib/regions.ts. The series reuses
 * the NA_EAST region/timezone machinery (America/New_York). Events are
 * stored as absolute UTC instants; clients render series-local + viewer-
 * local times.
 *
 * Single-series scope: the platform previously ran three regional brackets
 * (EU / NA East / NA West). It now runs a single US series. The REGIONS map
 * is intentionally left intact — TournamentDetail and other code import its
 * display helpers (e.g. regionDateLabel, region labels) for events that
 * still carry the NA_EAST region code.
 *
 * Idempotency: the scheduler computes the series' next Friday 20:00-local
 * instant deterministically, so "(region, scheduledAt) already exists" is an
 * exact-match check — re-runs and multi-instance races can only ever
 * find-or-create the same row. (No unique constraint needed; the worst race
 * outcome is a transient duplicate that the exact-match check prevents in
 * practice since the cron is single-instance today.)
 *
 * Release scope is FREE-ONLY (Stripe dormant): the weekly scheduler
 * creates no paid events at all. Paid creation remains possible only via
 * the admin route behind PAID_EVENTS_ENABLED.
 */

/**
 * The single weekly series runs on US-Eastern. We reuse the existing
 * NA_EAST region entry (America/New_York) so all region display helpers and
 * the stored Region enum value keep working unchanged.
 */
const SERIES_REGION = REGIONS.find((r) => r.code === "NA_EAST")!;

/** Name shown for the weekly event. Date/time are shown separately by the UI. */
const SERIES_NAME = "Online Weekly Tournament";

export async function ensureWeeklyTournaments(now: Date = new Date()) {
  const region = SERIES_REGION;
  const scheduledAt = nextWeeklyAt(region, now);
  const existing = await prisma.tournament.findFirst({
    where: { region: region.code, scheduledAt },
  });
  if (existing) return;

  const label = regionDateLabel(scheduledAt, region.tz);
  await prisma.tournament.create({
    data: {
      name: SERIES_NAME,
      description:
        "Free entry, open to all (US internet connection required). 16-player double elimination, best of 3. Check in within 15 minutes of start.",
      scheduledAt,
      region: region.code,
      format: "DOUBLE_ELIM",
      seriesFormat: "BO3",
      maxEntrants: 16,
      entryFee: 0,
      status: "REGISTRATION",
    },
  });
  console.log(
    `[scheduler] Created ${SERIES_NAME} for ${label} (${scheduledAt.toISOString()}).`
  );
}

/** Minutes past the scheduled start before an unstartable event cancels.
 *  Matches the "check in within 15 minutes of start" promise in the event copy. */
const START_GRACE_MINUTES = 15;

/** Start (or, past the grace window, cancel) tournaments whose time arrived */
export async function startDueTournaments() {
  const now = new Date();
  const due = await prisma.tournament.findMany({
    where: { status: "REGISTRATION", scheduledAt: { lte: now } },
  });
  for (const t of due) {
    const result = await startTournament(t.id);
    if (result.started) {
      emitTournamentUpdate(t.id, "started");
      console.log(`[scheduler] ${t.name}: started`);
      continue;
    }
    // Long-overdue and still unstartable (e.g. fewer than 2 check-ins):
    // cancel rather than re-evaluating forever.
    if (now.getTime() - t.scheduledAt.getTime() > START_GRACE_MINUTES * 60_000) {
      await prisma.tournament.update({ where: { id: t.id }, data: { status: "CANCELED" } });
      emitTournamentUpdate(t.id, "canceled");
      console.log(`[scheduler] ${t.name}: canceled (${result.reason}; past start grace)`);
    } else {
      console.log(`[scheduler] ${t.name}: not started (${result.reason})`);
    }
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

/** Boot + per-minute loop: ensure this week's US series exists, start due
 *  tournaments (close check-in, generate brackets), auto-DQ no-shows. */
export function startTournamentScheduler() {
  ensureWeeklyTournaments().catch(console.error);

  // Plain interval loop, NOT node-cron: node-cron v4 computes fire times
  // from the OS timezone database, and the node:20-slim production image
  // ships none — on prod the "every minute" schedule fired exactly once
  // (at midnight UTC) and silently died, which disabled the no-show sweep
  // and due-start entirely (found via the 2026-06-12 launch-gate test).
  // setInterval has no such dependency. The overlap guard keeps a slow
  // tick from stacking; the hourly heartbeat exists because every job in
  // this loop is silent when idle — without it, a dead loop is invisible.
  let ticking = false;
  let ticks = 0;
  setInterval(() => {
    if (ticking) return;
    ticking = true;
    void (async () => {
      try {
        ticks++;
        await ensureWeeklyTournaments().catch(console.error); // cheap + idempotent
        await startDueTournaments().catch(console.error);
        await sweepNoShowTournaments().catch(console.error);
        if (ticks % 60 === 0) {
          console.log(`[scheduler] alive — ${ticks} ticks`);
        }
      } finally {
        ticking = false;
      }
    })();
  }, 60_000);

  console.log(
    "[scheduler] Weekly scheduler started (1 US series every Friday at 20:00 US-Eastern; due-start + no-show sweep every minute)."
  );
}
