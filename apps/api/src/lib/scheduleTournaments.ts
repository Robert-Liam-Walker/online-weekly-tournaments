/**
 * scheduleTournaments.ts — Nightly tournament scheduler and no-show sweep loop.
 *
 * Purpose: Create each night's regional tournaments, auto-start them when their
 * scheduled time arrives, and auto-DQ players who go absent in a ready match.
 * This module owns the production scheduling loop; it is started once at server
 * boot by the app entrypoint.
 *
 * Nightly events (ensureNightlyTournaments):
 *   One free tournament per region (EU / NA East / NA West) at 20:00 local time
 *   each night. The scheduled UTC instant is computed by lib/regions.ts (DST-
 *   correct, zero external deps). Idempotent: the function looks for an existing
 *   row matching (region, scheduledAt) exactly — re-runs and multi-instance races
 *   safely find-or-create the same row.
 *   PAID events are NOT created here; paid creation is gated on PAID_EVENTS_ENABLED
 *   and available only via the admin route.
 *
 * Due-start and grace window (startDueTournaments):
 *   Any REGISTRATION tournament whose scheduledAt has passed is started (check-in
 *   closes, bracket generates). If startTournament fails (e.g. fewer than 2
 *   check-ins) and the event is more than START_GRACE_MINUTES (30) past its
 *   scheduled start, it is CANCELED rather than retried forever. Within the grace
 *   window the event remains in REGISTRATION (late check-ins are still possible).
 *
 * No-show sweep (sweepNoShowTournaments):
 *   For every ACTIVE tournament, any ready match (both players known, no winner)
 *   whose readyAt stamp is older than READY_TIMEOUT_MINUTES is checked for lobby
 *   presence (lib/presence.ts). Absent players are auto-DQ'd, which forfeits the
 *   match and may cascade through the bracket. Controlled by the
 *   READY_TIMEOUT_MINUTES env var (default: 10, "0" disables).
 *
 * Scheduler loop (startTournamentScheduler):
 *   Uses setInterval (NOT node-cron). Reason: node-cron v4 computes fire times
 *   from the OS timezone database, and the node:20-slim production image ships no
 *   tzdata. On production the "every minute" cron schedule fired exactly once (at
 *   midnight UTC) and then silently died, disabling the no-show sweep and due-start
 *   entirely (discovered during the 2026-06-12 launch-gate test). setInterval has
 *   no such dependency and fires reliably every 60 s.
 *
 *   Overlap guard: a boolean flag `ticking` prevents a slow tick from stacking
 *   when DB calls take longer than 60 s — the next interval fires but returns
 *   immediately if the previous tick is still running.
 *
 *   Hourly heartbeat: every 60 ticks (~1 hour) a "[scheduler] alive" log line
 *   is emitted. All jobs in the loop are silent when idle (no events due, no
 *   active tournaments), so without the heartbeat a dead loop would be invisible
 *   in production logs.
 *
 * Key exports:
 *   startTournamentScheduler   — start the production setInterval loop; call once at boot.
 *   ensureNightlyTournaments   — create tonight's events for all regions (idempotent).
 *   startDueTournaments        — start/cancel overdue REGISTRATION events.
 *   sweepNoShowTournaments     — auto-DQ no-shows in all ACTIVE tournaments.
 *   readyTimeoutMinutes        — read READY_TIMEOUT_MINUTES from env (live, no reload needed).
 *
 * Invariants:
 *   - startTournamentScheduler must be called exactly once per process.
 *   - The scheduler is not distributed: no leader-election, single-instance only
 *     today. The idempotency of ensureNightlyTournaments makes multi-instance safe
 *     for event creation, but startDueTournaments and sweepNoShowTournaments are not
 *     idempotent under concurrent execution and should remain single-instance.
 */
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
 *
 * @param now - reference instant (defaults to Date.now()); injectable for testing.
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

/**
 * Minutes past the scheduled start before an unstartable event is canceled.
 * Events within the grace window remain in REGISTRATION; late check-ins are
 * still accepted during this period.
 */
const START_GRACE_MINUTES = 30;

/**
 * Start (or, past the grace window, cancel) tournaments whose scheduled time has arrived.
 * Iterates all REGISTRATION tournaments with scheduledAt <= now, attempts to start
 * each, and cancels any that remain unstartable after START_GRACE_MINUTES.
 *
 * Emits "started" or "canceled" socket events after each state change.
 */
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
 * Read the no-show auto-DQ timeout from the environment.
 * @returns Minutes a ready match may sit before absent players are DQ'd.
 *   Defaults to 10; "0" disables the sweep. Read at call time so tests and
 *   ops tooling can flip it without a server restart.
 */
export function readyTimeoutMinutes(): number {
  const raw = process.env.READY_TIMEOUT_MINUTES ?? "10";
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10;
}

/**
 * Auto-DQ no-shows in every ACTIVE tournament (no-op when the timeout is disabled).
 * For each active tournament, calls bracketService.sweepNoShows with the current
 * timeout, then emits socket events for any DQ'd players.
 *
 * Per-tournament errors are caught and logged (with the tournament name) so a
 * busy lock on one tournament (players actively reporting results) does not block
 * sweeps of the remaining tournaments.
 */
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

/**
 * Start the production nightly-tournament scheduler loop.
 * Runs ensureNightlyTournaments once immediately at boot, then fires all three
 * jobs (ensure, startDue, sweepNoShows) every 60 seconds via setInterval.
 *
 * NOT node-cron: see module header for the full rationale. In brief, node-cron
 * v4 requires tzdata (absent from node:20-slim), causing the schedule to fire
 * only once and then silently die. setInterval has no such dependency.
 *
 * Call this exactly once at server startup.
 */
export function startTournamentScheduler() {
  ensureNightlyTournaments().catch(console.error);

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
        await ensureNightlyTournaments().catch(console.error); // cheap + idempotent
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
    "[scheduler] Nightly scheduler started (3 regional events/night at 20:00 local; due-start + no-show sweep every minute)."
  );
}
