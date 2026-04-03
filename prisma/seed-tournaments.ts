/**
 * Creates this week's free + paid tournaments.
 * Run with: npx tsx prisma/seed-tournaments.ts
 *
 * Schedules both tournaments for the coming Saturday:
 *   - Free:  Saturday 2:00 PM ET
 *   - Paid:  Saturday 5:00 PM ET  ($5 entry)
 *
 * Idempotent — won't create duplicates if run again for the same week.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function nextSaturday(hour: number): Date {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 6=Sat
  const daysUntilSat = day === 6 ? 7 : 6 - day; // if today is Sat, schedule next week

  const sat = new Date(now);
  sat.setDate(now.getDate() + daysUntilSat);
  sat.setHours(hour, 0, 0, 0);
  return sat;
}

function weekLabel(): string {
  const sat = nextSaturday(14);
  return sat.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

async function main() {
  const freeTime = nextSaturday(14); // 2:00 PM
  const paidTime = nextSaturday(17); // 5:00 PM
  const label = weekLabel();

  // Check for existing tournaments on those dates to stay idempotent
  const existing = await prisma.tournament.findMany({
    where: {
      scheduledAt: { gte: freeTime, lte: paidTime },
    },
  });

  if (existing.length > 0) {
    console.log(`Tournaments already exist for the week of ${label}. Skipping.`);
    process.exit(0);
  }

  const [free, paid] = await Promise.all([
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
        entryFee: 500, // $5.00 in cents
        status: "REGISTRATION",
      },
    }),
  ]);

  console.log(`Created: "${free.name}" (free) at ${freeTime.toISOString()}`);
  console.log(`Created: "${paid.name}" ($5) at ${paidTime.toISOString()}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
