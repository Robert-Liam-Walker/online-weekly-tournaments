// Ensure an ADMIN web account exists with a known username + password.
// Idempotent: upserts by username, (re)sets the password hash and ADMIN role.
//
// Defaults create `admin` / `***REMOVED***`. Override via env:
//   ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_LOGIN_EMAIL
//
// Local:  npx -w apps/api tsx scripts/ensure-admin.ts
// Prod:   no source in the container — use the inline `node -e` SSM recipe
//         (see docs/DEPLOY.md); this script documents the same effect.
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";

async function main() {
  const username = process.env.ADMIN_USERNAME ?? "admin";
  const password = process.env.ADMIN_PASSWORD ?? "***REMOVED***";
  const email = process.env.ADMIN_LOGIN_EMAIL ?? "admin@nightlytournament.service";
  const passwordHash = await bcrypt.hash(password, 12);

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    await prisma.user.update({
      where: { username },
      data: { passwordHash, role: "ADMIN" },
    });
    console.log(`updated admin user "${username}" (id ${existing.id}) — password reset, role ADMIN`);
  } else {
    const created = await prisma.user.create({
      data: { username, email, passwordHash, role: "ADMIN" },
    });
    console.log(`created admin user "${username}" (id ${created.id}, email ${email})`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
