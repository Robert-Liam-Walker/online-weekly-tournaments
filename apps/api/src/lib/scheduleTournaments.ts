import cron from "node-cron";
import { prisma } from "./prisma";
import { startTournament, sweepNoShows } from "./bracketService";
import { emitTournamentUpdate } from "./tournamentEvents";

/**
 * Upcoming Saturday at the given hour, computed explicitly in UTC.
 *
 * Timezone policy: event times are stored and compared as absolute UTC instants
 * (built via Date.UTC) so the server's local timezone can never shift them.
 * Clients are responsible for rendering these instants in the viewer's local time.
 *
 * If today (in UTC) is Saturday, schedules for the following Saturday.
 */
function nextSaturdayUtc(hour: number): Date {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 6=Sat
  const daysUntilSat = day === 6 ? 7 : 6 - day;
  // Date.UTC normalizes day-of-month overflow (e.g. Jan 30 + 6 days -> Feb 5).
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilSat, hour, 0, 0, 0)
  );
}

function weekLabel(): string {
  return nextSaturdayUtc(14).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC", // label must match the event's UTC date regardless of server timezone
  });
}

export async function createWeeklyTournaments() {
  // Public launch is FREE EVENTS ONLY: the paid Saturday event is created only
  // when PAID_EVENTS_ENABLED === "true". Unset/anything else => free event only.
  const paidEventsEnabled = process.env.PAID_EVENTS_ENABLED === "true";

  const freeTime = nextSaturdayUtc(14); // Saturday 14:00 UTC
  const paidTime = nextSaturdayUtc(17); // Saturday 17:00 UTC

  // Idempotent — skip if tournaments already exist for this Saturday.
  // The window intentionally spans the full 14:00–17:00 UTC slot even when paid
  // events are disabled, so re-runs never duplicate the free event.
  const existing = await prisma.tournament.findFirst({
    where: { scheduledAt: { gte: freeTime, lte: paidTime } },
  });

  if (existing) {
    console.log(`[scheduler] Tournaments already exist for ${weekLabel()}, skipping.`);
    return;
  }

  const label = weekLabel();

  const creates: Promise<unknown>[] = [
    prisma.tournament.create({
      data: {
        name: `Weekly Open — ${label}`,
        description: "Free entry, open to all. Best of 3, single elimination.",
        scheduledAt: freeTime,
        format: "SINGLE_ELIM",
        seriesFormat: "BO3",
        maxEntrants: 32,
        entryFee: 0,
        status: "REGISTRATION",
      },
    }),
  ];

  if (paidEventsEnabled) {
    creates.push(
      prisma.tournament.create({
        data: {
          name: `Weekly Invitational — ${label}`,
          description:
            "$5 entry. Prize pool paid out to top 3: 50% / 25% / 10%. Best of 5, double elimination.",
          scheduledAt: paidTime,
          format: "DOUBLE_ELIM",
          seriesFormat: "BO5",
          maxEntrants: 16,
          entryFee: 500,
          status: "REGISTRATION",
        },
      })
    );
  }

  await Promise.all(creates);

  console.log(
    `[scheduler] Created ${paidEventsEnabled ? "free + paid" : "free-only"} weekly tournament(s) for ${label}.`
  );
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

/** Runs every Monday at 9:00 AM to create that week's Saturday tournaments. */
export function startTournamentScheduler() {
  // Create immediately on startup if none exist yet
  createWeeklyTournaments().catch(console.error);

  // Then re-run every Monday at 09:00
  cron.schedule("0 9 * * 1", () => {
    createWeeklyTournaments().catch(console.error);
  });

  // Start due tournaments (close check-in, generate brackets) every minute,
  // then auto-DQ no-shows across ACTIVE tournaments.
  cron.schedule("* * * * *", async () => {
    await startDueTournaments().catch(console.error);
    await sweepNoShowTournaments().catch(console.error);
  });

  console.log(
    "[scheduler] Tournament scheduler started (creates Mondays 09:00, starts due tournaments every minute)."
  );
}
