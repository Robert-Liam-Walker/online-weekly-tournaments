import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const players = [
  { username: "Mango",      email: "mango@test.com",  note: "Fox/Falco, serious matches only" },
  { username: "Armada",     email: "armada@test.com", note: "Peach main, Bo5 preferred" },
  { username: "Hungrybox",  email: "hbox@test.com",   note: "Jigglypuff, will counterpick" },
  { username: "Leffen",     email: "leffen@test.com", note: null },
  { username: "PPMD",       email: "ppmd@test.com",   note: "Falco/Marth, friendly games" },
  { username: "Westballz",  email: "west@test.com",   note: "Tech skill practice welcome" },
];

async function main() {
  const hash = await bcrypt.hash("password123", 12);

  for (const p of players) {
    const user = await prisma.user.upsert({
      where: { email: p.email },
      update: { subscriptionStatus: "ACTIVE" },
      create: {
        username: p.username,
        email: p.email,
        passwordHash: hash,
        subscriptionStatus: "ACTIVE",
      },
    });

    await prisma.arenaEntry.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        format: Math.random() > 0.5 ? "BO5" : "BO3",
        note: p.note ?? undefined,
      },
    });

    console.log(`Seeded ${p.username}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
