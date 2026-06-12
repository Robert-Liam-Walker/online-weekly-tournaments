import "dotenv/config"; // load apps/api/.env when run standalone (run from apps/api/)
// End-to-end smoke for the device link flow, against the running API:
//   npx -w apps/api tsx scripts/smoke-device-link.ts
const BASE = "http://127.0.0.1:3001/api";

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

  // 3. A logged-in user confirms (web session simulated via game-login)
  const login = await req("POST", "/auth/game-login", { connectCode: "WEDE#971" });
  expect(login.status === 200, "session for confirm step");
  const confirm = await req("POST", "/device/link/confirm", { code }, login.body.token);
  expect(confirm.status === 200 && confirm.body.confirmed === true, "confirm succeeds");

  // 4. Double-confirm is rejected
  const confirm2 = await req("POST", "/device/link/confirm", { code }, login.body.token);
  expect(confirm2.status === 409, "second confirm rejected");

  // 5. Status hands out the token exactly once
  const got = await req("GET", `/device/link/status?code=${code}`);
  expect(got.body.status === "CONFIRMED" && !!got.body.token, "status returns token after confirm");
  expect(got.body.user.connectCode === "WEDE#971", "token bound to confirming user");

  const again = await req("GET", `/device/link/status?code=${code}`);
  expect(again.status === 410, "token handed out exactly once");

  // 6. The issued token authenticates
  const me = await req("GET", "/auth/me", undefined, got.body.token);
  expect(me.status === 200 && me.body.connectCode === "WEDE#971", "issued token works on /auth/me");

  // 7. Unknown code
  const bad = await req("GET", "/device/link/status?code=ZZZZZZ");
  expect(bad.status === 404, "unknown code 404s");

  console.log("OK: device link flow (issue, pending, confirm, one-shot token, auth) all pass");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
