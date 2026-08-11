import "dotenv/config"; // load apps/api/.env when run standalone (run from apps/api/)
// Dev helper: give the seeded dev account a real password for web login.
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";

async function main() {
  const password = process.env.DEV_PASSWORD;
  if (!password) {
    console.error("DEV_PASSWORD is required (no default). Set it and re-run.");
    process.exit(1);
  }
  const username = process.env.DEV_USERNAME ?? "robert";
  const hash = await bcrypt.hash(password, 12);
  await prisma.user.update({ where: { username }, data: { passwordHash: hash } });
  console.log(`dev password set for ${username}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
