import "dotenv/config"; // load apps/api/.env when run standalone (run from apps/api/)
// Seeds PRODUCTION (or any deployed env) with web-testing demo data, purely
// through the public HTTP API — prod RDS is VPC-locked, so unlike
// seed-32-demo.ts this never touches Prisma:
//
//   SEED_ADMIN_PASSWORD=... npx -w apps/api tsx scripts/seed-prod-web-demo.ts
//
// What it does:
//   1. Logs in (or registers, which ADMIN_EMAIL-bootstraps to ADMIN) the
//      operator account.
//   2. Creates "Randalls 32 Demo" (DE, BO3, cap 32) starting ~7 min out.
//   3. Registers 32 demo users (paced ~7s apart — /auth/* allows 10/min/IP),
//      enters + checks in all of them.
//   4. Sprinkles demo users into tonight's three nightly regionals
//      (entry only, no check-in — they'll be excluded at start as usual).
//   5. Waits for the per-minute cron to auto-start the demo, then reports
//      all of W1, half of L1, 40% of W2 so the bracket shows decided,
//      in-progress, and pending sets.
//
// NOTE: run with READY_TIMEOUT_MINUTES=0 on the target env, or the no-show
// sweep will DQ the idle demo players 10 minutes after start.
// Demo users share DEMO_PASSWORD below — delete these accounts before launch.

const API = process.env.SEED_API_URL ?? "https://randallsnightly.com/api";
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "robert.liam.walker@gmail.com";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD;
const DEMO_PASSWORD = "RandallsDemo32x";
const NAME = "Randalls 32 Demo";
const TAG = "demo32";
const AUTH_PACE_MS = 7000;

const FAKE_NAMES = [
  "CloudNine", "StadiumStorm", "RandallFan", "WhispyWinds", "PichuPower",
  "MarthMain", "FalcoLasers", "ShineSpike", "WaveDashWiz", "LCancelLord",
  "EddsMash", "TomatoKirby", "GreenGreens", "YoshiEgg", "DKPunch",
  "NessYoyo", "SamusCharge", "LinkBoomer", "ZeldaWarp", "GanonStomp",
  "MewtwoTail", "IceClimber", "PeachTurnip", "BowserFlame", "FoxTrotter",
  "JigglyRest", "DocPills", "YLinkBombs", "RoyFlare", "PikaThunder",
  "LuigiCyclone", "MrGameWatch",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      // Fastify 400s on a JSON content-type with an empty body, so only
      // declare it when a body is actually sent.
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON (e.g. 429 text) — leave null
  }
  return { status: res.status, data };
}

// Auth calls share a strict 10/min/IP budget; on 429 wait out the window.
async function authCall(path: string, body: unknown) {
  for (;;) {
    const r = await call("POST", path, undefined, body);
    if (r.status !== 429) return r;
    console.log(`  429 on ${path} — waiting 35s for the rate-limit window`);
    await sleep(35_000);
  }
}

/** Login, or register when the account doesn't exist yet. Returns token+id. */
async function loginOrRegister(
  username: string,
  email: string,
  password: string,
  connectCode: string
): Promise<{ token: string; userId: string; created: boolean }> {
  const login = await authCall("/auth/login", { email, password });
  if (login.status === 200) {
    return { token: login.data.token, userId: login.data.user.id, created: false };
  }
  const reg = await authCall("/auth/register", { username, email, password, connectCode });
  if (reg.status !== 200 && reg.status !== 201) {
    throw new Error(`register ${username} failed: ${reg.status} ${JSON.stringify(reg.data)}`);
  }
  return { token: reg.data.token, userId: reg.data.user.id, created: true };
}

async function main() {
  if (!ADMIN_PASSWORD) throw new Error("SEED_ADMIN_PASSWORD is required");

  // --- 1. Operator account (ADMIN_EMAIL bootstrap promotes it) ------------
  const admin = await loginOrRegister("robert", ADMIN_EMAIL, ADMIN_PASSWORD, "WEDE#971");
  console.log(`admin: ${admin.created ? "registered" : "logged in"}`);

  // --- 2. Demo tournament. A previous abandoned demo (no results yet) is
  // canceled via the TO endpoint; an ACTIVE/COMPLETED one means data already
  // exists — abort rather than duplicate.
  const all = (await call("GET", "/tournaments", admin.token)).data;
  for (const t of Array.isArray(all) ? all : []) {
    if (t.name !== NAME || t.status === "CANCELED") continue;
    if (t.status === "UPCOMING" || t.status === "REGISTRATION") {
      const cancel = await call("POST", `/tournaments/${t.id}/cancel`, admin.token);
      if (cancel.status !== 200) {
        throw new Error(`could not cancel stale demo ${t.id}: ${JSON.stringify(cancel.data)}`);
      }
      console.log(`canceled stale "${NAME}" (${t.id})`);
    } else {
      throw new Error(`"${NAME}" already ${t.status} on ${API} — not creating a duplicate`);
    }
  }

  const scheduledAt = new Date(Date.now() + 7 * 60_000);
  const create = await call("POST", "/tournaments", admin.token, {
    name: NAME,
    description: "Seeded 32-man bracket for web/in-game UI verification.",
    scheduledAt: scheduledAt.toISOString(),
    format: "DOUBLE_ELIM",
    seriesFormat: "BO3",
    maxEntrants: 32,
    entryFee: 0,
  });
  if (create.status !== 201) {
    throw new Error(`create failed: ${create.status} ${JSON.stringify(create.data)}`);
  }
  const demoId: string = create.data.id;
  console.log(`created "${NAME}" id=${demoId}, starts ${scheduledAt.toISOString()}`);

  // Tonight's regionals, for entrant-list variety on the site.
  const regionals: { id: string; region: string }[] = (Array.isArray(all) ? all : [])
    .filter((t: any) => t.region && t.status === "REGISTRATION")
    .map((t: any) => ({ id: t.id, region: t.region }));

  // --- 3. Demo users: register/login, enter demo, check in ----------------
  const tokens = new Map<string, string>(); // userId -> token
  for (let i = 0; i < 32; i++) {
    const username = FAKE_NAMES[i];
    const u = await loginOrRegister(
      username,
      `${TAG}-${i}@example.invalid`,
      DEMO_PASSWORD,
      `DEMO#${i + 1}`
    );
    tokens.set(u.userId, u.token);

    const enter = await call("POST", `/tournaments/${demoId}/register`, u.token);
    if (enter.status !== 201) {
      console.log(`  WARN ${username} enter: ${enter.status} ${JSON.stringify(enter.data)}`);
    }
    const checkin = await call("POST", `/tournaments/${demoId}/checkin`, u.token);
    if (checkin.status !== 200) {
      console.log(`  WARN ${username} checkin: ${checkin.status} ${JSON.stringify(checkin.data)}`);
    }

    // --- 4. A slice of users also enters tonight's regionals (no check-in)
    for (let r = 0; r < regionals.length; r++) {
      if (i >= r * 6 && i < r * 6 + 10) {
        await call("POST", `/tournaments/${regionals[r].id}/register`, u.token);
      }
    }

    console.log(`  ${i + 1}/32 ${username} ready${u.created ? "" : " (existing)"}`);
    if (i < 31) await sleep(AUTH_PACE_MS);
  }

  // --- 5. Wait for the cron auto-start, then report a visual spread -------
  console.log("waiting for auto-start (per-minute cron)...");
  const deadline = scheduledAt.getTime() + 5 * 60_000;
  for (;;) {
    const t = (await call("GET", `/tournaments/${demoId}`, admin.token)).data;
    if (t.status === "ACTIVE") break;
    if (Date.now() > deadline) {
      const manual = await call("POST", `/tournaments/${demoId}/start`, admin.token);
      if (manual.status !== 200) {
        throw new Error(`auto+manual start failed: ${JSON.stringify(manual.data)}`);
      }
      break;
    }
    await sleep(20_000);
  }
  console.log("ACTIVE — reporting results");

  const reportSome = async (prefix: string, fraction: number) => {
    const detail = (await call("GET", `/tournaments/${demoId}`, admin.token)).data;
    const matches = detail.matches
      .filter((m: any) => m.matchKey.startsWith(prefix) && !m.winnerId)
      .sort((a: any, b: any) => a.matchKey.localeCompare(b.matchKey));
    const count = Math.ceil(matches.length * fraction);
    for (const m of matches.slice(0, count)) {
      if (!m.player1Id || !m.player2Id) continue;
      const winner = m.matchKey.endsWith("3") ? m.player2Id : m.player1Id;
      const reporter = tokens.get(m.player1Id) ?? tokens.get(m.player2Id);
      if (!reporter) continue;
      const rep = await call(
        "POST",
        `/tournaments/${demoId}/matches/${m.matchKey}/report`,
        reporter,
        { winnerId: winner }
      );
      if (rep.status !== 200) {
        console.log(`  WARN report ${m.matchKey}: ${rep.status} ${JSON.stringify(rep.data)}`);
      }
      await sleep(250);
    }
  };

  await reportSome("W1-", 1.0);
  await reportSome("L1-", 0.5);
  await reportSome("W2-", 0.4);

  const final = (await call("GET", `/tournaments/${demoId}`, admin.token)).data;
  const decided = final.matches.filter((m: any) => m.winnerId).length;
  console.log(
    `OK: "${NAME}" — ${decided}/${final.matches.length} sets decided, status ${final.status}`
  );
  console.log(`web: ${API.replace(/\/api$/, "")}/tournaments/${demoId}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
