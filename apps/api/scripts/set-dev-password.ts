import "dotenv/config"; // load apps/api/.env when run standalone (run from apps/api/)
// Dev helper: give the seeded dev account a real password for web login.
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";

async function main() {
  const hash = await bcrypt.hash("***REMOVED***", 12);
  await prisma.user.update({ where: { username: "robert" }, data: { passwordHash: hash } });
  console.log("dev password set for robert: ***REMOVED***");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
