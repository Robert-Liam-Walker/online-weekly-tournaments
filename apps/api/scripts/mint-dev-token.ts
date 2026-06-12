import "dotenv/config"; // load apps/api/.env when run standalone (run from apps/api/)
// Mints a game-client JWT for a dev user, so a second local Dolphin instance
// can be authenticated without the manual device-link dance (write the output
// to that instance's User/Slippi/foxtrot-token.txt). DEV ONLY — uses the
// local JWT_SECRET; useless against prod. Signed by hand with node crypto
// (HS256, same shape @fastify/jwt produces) to avoid adding a dependency.
//
//   npx tsx scripts/mint-dev-token.ts BracketDemoFoe

import { createHmac } from "crypto";
import { prisma } from "../src/lib/prisma";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signHs256(payload: object, secret: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

async function main() {
  const username = process.argv[2];
  if (!username) throw new Error("usage: mint-dev-token.ts <username>");
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET missing from apps/api/.env");

  const user = await prisma.user.findFirst({ where: { username } });
  if (!user) throw new Error(`no user named ${username} (run the seeds first)`);

  // Same payload the API signs ({id}); device-link tokens live 30 days.
  const now = Math.floor(Date.now() / 1000);
  const token = signHs256({ id: user.id, iat: now, exp: now + 30 * 86400 }, secret);
  console.log(token);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
