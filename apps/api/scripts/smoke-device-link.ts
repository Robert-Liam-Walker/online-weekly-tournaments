import "dotenv/config"; // load apps/api/.env when run standalone (run from apps/api/)
// End-to-end smoke for the device link flow, against the running API:
//   npx -w apps/api tsx scripts/smoke-device-link.ts
import { createHmac } from "crypto";
import { prisma } from "../src/lib/prisma";

const BASE = "http://127.0.0.1:3001/api";

// Dev-only HS256 JWT mint (same shape @fastify/jwt produces) — replaces the
// removed /auth/game-login dependency; see mint-dev-token.ts.
function mintToken(userId: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET missing from apps/api/.env");
  const b64url = (input: string) => Buffer.from(input).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ id: userId, iat: now, exp: now + 86400 }));
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

async function req(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

function expect(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function main() {
  // 1. Game asks for a code
  const start = await req("POST", "/device/link/start");
  expect(start.status === 200 && /^[A-Z2-9]{6}$/.test(start.body.code), "start issues a 6-char code");
  const code = start.body.code;

  // 2. Status is PENDING before confirmation
  const pending = await req("GET", `/device/link/status?code=${code}`);
  expect(pending.body.status === "PENDING", "status PENDING before confirm");

  // 3. A logged-in user confirms (web session simulated via a minted dev JWT)
  const username = process.env.SEED_USERNAME ?? "robert";
  const devUser = await prisma.user.findUnique({ where: { username } });
  if (!devUser) throw new Error(`user ${username} missing - run seed-dev-events.ts first`);
  const sessionToken = mintToken(devUser.id);
  const confirm = await req("POST", "/device/link/confirm", { code }, sessionToken);
  expect(confirm.status === 200 && confirm.body.confirmed === true, "confirm succeeds");

  // 4. Double-confirm is rejected
  const confirm2 = await req("POST", "/device/link/confirm", { code }, sessionToken);
  expect(confirm2.status === 409, "second confirm rejected");

  // 5. Status hands out the token exactly once
  const got = await req("GET", `/device/link/status?code=${code}`);
  expect(got.body.status === "CONFIRMED" && !!got.body.token, "status returns token after confirm");
  expect(got.body.user.username === devUser.username, "token bound to confirming user");

  const again = await req("GET", `/device/link/status?code=${code}`);
  expect(again.status === 410, "token handed out exactly once");

  // 6. The issued token authenticates
  const me = await req("GET", "/auth/me", undefined, got.body.token);
  expect(me.status === 200 && me.body.username === devUser.username, "issued token works on /auth/me");

  // 7. Unknown code
  const bad = await req("GET", "/device/link/status?code=ZZZZZZ");
  expect(bad.status === 404, "unknown code 404s");

  console.log("OK: device link flow (issue, pending, confirm, one-shot token, auth) all pass");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
