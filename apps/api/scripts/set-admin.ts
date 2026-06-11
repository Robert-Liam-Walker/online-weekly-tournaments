// Promote a user to ADMIN by username or email:
//   npx -w apps/api tsx scripts/set-admin.ts <username-or-email>

import { prisma } from "../src/lib/prisma";

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: tsx scripts/set-admin.ts <username-or-email>");
    process.exit(1);
  }

  const user = await prisma.user.findFirst({
    where: { OR: [{ username: arg }, { email: arg }] },
  });
  if (!user) {
    console.error(`no user found with username or email "${arg}"`);
    process.exit(1);
  }

  if (user.role === "ADMIN") {
    console.log(`${user.username} <${user.email}> is already ADMIN — nothing to do`);
    return;
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { role: "ADMIN" },
  });
  console.log(`OK: ${updated.username} <${updated.email}> role is now ${updated.role}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
