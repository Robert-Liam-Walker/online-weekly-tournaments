// Full prod rendezvous preflight, driven entirely through the PUBLIC API
// from OUTSIDE the cloud (no DB access). Proves the whole release-blocking
// chain end to end: register/login -> admin event -> register/check-in ->
// auto-start -> /ready tickets -> real UDP announce pair against the prod
// registrar -> complementary peer responses.
//
//   npx tsx scripts/preflight-prod-rendezvous.ts \
//     --api https://onlineweeklytournaments.com/api \
//     --admin-email you@example.com --admin-pass secret \
//     --second-email test+rdv@example.com --second-pass secret2
//
// Accounts that don't exist yet are registered (the admin email must be the
// API's ADMIN_EMAIL so the bootstrap promotes it). The preflight event it
// creates is left ACTIVE with an unplayed ready match — the production
// no-show sweep DQs both entrants after READY_TIMEOUT_MINUTES (default 10)
// and completes the event, so the test self-cleans.
import "dotenv/config";
import dgram from "node:dgram";
import os from "node:os";

type Args = Record<string, string>;
const args: Args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
}
const API = args["api"] ?? "https://onlineweeklytournaments.com/api";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

async function http<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = text as unknown as T;
  }
  return { status: res.status, data };
}

type LoginResp = { user: { id: string; username: string }; token: string };

async function loginOrRegister(email: string, pass: string, username: string): Promise<LoginResp> {
  const login = await http<LoginResp>("POST", "/auth/login", { email, password: pass });
  if (login.status === 200) {
    console.log(`  logged in as ${login.data.user.username}`);
    return login.data;
  }
  console.log(`  no login for ${email} (${login.status}) — registering ${username}`);
  const reg = await http<LoginResp>("POST", "/auth/register", { username, email, password: pass });
  if (reg.status !== 201) fail(`register ${username}: ${reg.status} ${JSON.stringify(reg.data)}`);
  return reg.data;
}

function lanEndpoint(port: number): string {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        const [a, b] = iface.address.split(".").map(Number);
        if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
          return `${iface.address}:${port}`;
        }
      }
    }
  }
  return `192.168.0.2:${port}`; // schema-valid fallback
}

type Ticket = {
  token: string;
  isDecider: boolean;
  playerIndex: number;
  matchId: string;
  udpHost: string;
  udpPort: number;
};

function announceAndAwait(ticket: Ticket, label: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const nonce = "pf" + Math.random().toString(36).slice(2, 12);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${label}: no UDP reply in 8s`));
    }, 8000);
    socket.on("message", (data) => {
      const parsed = JSON.parse(data.toString("utf8"));
      if (parsed.t === "wait") return; // opponent hasn't announced yet — keep waiting (we re-announce)
      clearTimeout(timer);
      socket.close();
      resolve(parsed);
    });
    const send = () =>
      socket.send(
        JSON.stringify({ t: "announce", v: 1, tok: ticket.token, nonce, lan: lanEndpoint(40000 + Math.floor(Math.random() * 1000)) }),
        ticket.udpPort,
        ticket.udpHost,
      );
    send();
    const resend = setInterval(send, 1500);
    socket.on("close", () => clearInterval(resend));
  });
}

async function main() {
  const adminEmail = args["admin-email"] ?? fail("--admin-email required");
  const adminPass = args["admin-pass"] ?? fail("--admin-pass required");
  const secondEmail = args["second-email"] ?? fail("--second-email required");
  const secondPass = args["second-pass"] ?? fail("--second-pass required");

  console.log(`1. Accounts (${API})`);
  const admin = await loginOrRegister(adminEmail, adminPass, args["admin-username"] ?? "robert");
  const second = await loginOrRegister(secondEmail, secondPass, args["second-username"] ?? "RdvProbe");

  console.log("2. Admin creates the preflight event");
  const create = await http<{ id: string }>(
    "POST",
    "/tournaments",
    {
      name: `Rendezvous Preflight ${new Date().toISOString().slice(11, 19)}`,
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      format: "DOUBLE_ELIM",
      maxEntrants: 4,
    },
    admin.token,
  );
  if (create.status !== 201) fail(`create event: ${create.status} ${JSON.stringify(create.data)}`);
  const eventId = create.data.id;
  console.log(`  event ${eventId}`);

  console.log("3. Both register + check in");
  for (const [who, token] of [
    ["admin", admin.token],
    ["second", second.token],
  ] as const) {
    const r = await http("POST", `/tournaments/${eventId}/register`, {}, token);
    if (r.status >= 300) fail(`${who} register: ${r.status} ${JSON.stringify(r.data)}`);
    const c = await http("POST", `/tournaments/${eventId}/checkin`, {}, token);
    if (c.status >= 300) fail(`${who} checkin: ${c.status} ${JSON.stringify(c.data)}`);
  }

  console.log("4. Waiting for auto-start (per-minute cron)...");
  let active = false;
  for (let i = 0; i < 30; i++) {
    const t = await http<{ status: string }>("GET", `/tournaments/${eventId}`, undefined, admin.token);
    if ((t.data as any).status === "ACTIVE") {
      active = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  if (!active) fail("event never went ACTIVE (auto-start cron)");
  console.log("  ACTIVE");

  console.log("5. Fetching /ready tickets");
  const tickets: Ticket[] = [];
  for (const token of [admin.token, second.token]) {
    const r = await http<{ matches: Array<{ rendezvous?: Ticket }> }>(
      "GET",
      `/tournaments/${eventId}/ready`,
      undefined,
      token,
    );
    const ticket = r.data.matches?.[0]?.rendezvous;
    if (!ticket) fail(`no rendezvous ticket in /ready: ${JSON.stringify(r.data)}`);
    tickets.push(ticket);
  }
  const [a, b] = tickets;
  if (a.matchId !== b.matchId) fail(`matchId mismatch: ${a.matchId} vs ${b.matchId}`);
  if (a.token === b.token) fail("tickets share a token");
  if (a.isDecider === b.isDecider || a.playerIndex === b.playerIndex) {
    fail("tickets are not complementary");
  }
  console.log(`  matchId ${a.matchId}; advertising registrar ${a.udpHost}:${a.udpPort}`);

  console.log("6. UDP announce pair against the prod registrar");
  const [peerA, peerB] = await Promise.all([announceAndAwait(a, "A"), announceAndAwait(b, "B")]);
  console.log(`  A got: ${JSON.stringify(peerA)}`);
  console.log(`  B got: ${JSON.stringify(peerB)}`);
  if (peerA.t !== "peer" || peerB.t !== "peer") fail("expected peer responses for both");

  console.log(
    "PASS: full prod chain green (accounts, admin event, registration, auto-start, /ready tickets, UDP pairing). " +
      "The preflight event self-cleans via the no-show sweep.",
  );
}

main().catch((err) => fail(String(err)));
