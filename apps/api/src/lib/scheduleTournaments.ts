import cron from "node-cron";
import { prisma } from "./prisma";

/** Next Saturday at the given hour (local server time). If today is Saturday, schedules for next Saturday. */
function nextSaturday(hour: number): Date {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 6=Sat
  const daysUntilSat = day === 6 ? 7 : 6 - day;
  const sat = new Date(now);
  sat.setDate(now.getDate() + daysUntilSat);
  sat.setHours(hour, 0, 0, 0);
  return sat;
}

function weekLabel(): string {
  return nextSaturday(14).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export async function createWeeklyTournaments() {
  const freeTime = nextSaturday(14); // 2:00 PM
  const paidTime = nextSaturday(17); // 5:00 PM

  // Idempotent — skip if tournaments already exist for this Saturday
  const existing = await prisma.tournament.findFirst({
    where: { scheduledAt: { gte: freeTime, lte: paidTime } },
  });

  if (existing) {
    console.log(`[scheduler] Tournaments already exist for ${weekLabel()}, skipping.`);
    return;
  }

  const label = weekLabel();

  await Promise.all([
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
    prisma.tournament.create({
      data: {
        name: `Weekly Invitational — ${label}`,
        description:
          "$5 entry. Prize pool paid out to top 3: 50% / 25% / 10%. Best of 5, single elimination.",
        scheduledAt: paidTime,
        format: "SINGLE_ELIM",
        seriesFormat: "BO5",
        maxEntrants: 16,
        entryFee: 500,
        status: "REGISTRATION",
      },
    }),
  ]);

  console.log(`[scheduler] Created weekly tournaments for ${label}.`);
}

/** Runs every Monday at 9:00 AM to create that week's Saturday tournaments. */
export function startTournamentScheduler() {
  // Create immediately on startup if none exist yet
  createWeeklyTournaments().catch(console.error);

  // Then re-run every Monday at 09:00
  cron.schedule("0 9 * * 1", () => {
    createWeeklyTournaments().catch(console.error);
  });

  console.log("[scheduler] Tournament scheduler started (runs Mondays at 09:00).");
}
