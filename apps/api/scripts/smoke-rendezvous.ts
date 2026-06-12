// Phase-0 gate for the match rendezvous (run from apps/api/ with the dev
// docker stack up — postgres + redis):
//
//   npx tsx scripts/smoke-rendezvous.ts
//
// Proves, end to end over real UDP on localhost:
//   1. idempotent minting — repeated /ready-equivalent polls return the same
//      token for the same (tournament, match, user)
//   2. two clients announce → both receive `peer` with correct slot identity
//      (decider/idx), each other's endpoints, and echoed nonces
//   3. lifecycle invariant A — after reportTournamentResult, announcing
//      clients receive an explicit invalidated error and cannot pair
//   4. lifecycle invariant B — same, after a DQ forfeits the match
//
// The registrar is started in-process on a scratch port: it is stateless by
// design (all state in Redis), so this is exactly the production code path.

import "dotenv/config"; // scripts run standalone — load apps/api/.env (run from apps/api/)
import dgram from "dgram";
import { prisma } from "../src/lib/prisma";
import { redis } from "../src/lib/redis";
import {
  dqTournamentEntry,
  getReadyTournamentMatches,
  reportTournamentResult,
  startTournament,
} from "../src/lib/bracketService";
import { getOrCreateRendezvous, RdvResponse } from "../src/lib/rendezvous";
import { startUdpRegistrar } from "../src/udpRegistrar";

const PORT = 41199;
const NAME = "Rdv Smoke";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

async function makeReadyMatch(suffix: string): Promise<{
  tournamentId: string;
  matchKey: string;
  p1: string;
  p2: string;
}> {
  const users: string[] = [];
  for (const n of [1, 2]) {
    const u = await prisma.user.upsert({
      where: { email: `rdv-smoke-${n}@example.invalid` },
      update: {},
      create: {
        username: `RdvSmoke${n}`,
        email: `rdv-smoke-${n}@example.invalid`,
        passwordHash: "x",
        connectCode: `RV0${n}#90${n}`,
      },
    });
    users.push(u.id);
  }
  const t = await prisma.tournament.create({
    data: {
      name: `${NAME} ${suffix}`,
      scheduledAt: new Date(),
      format: "DOUBLE_ELIM",
      seriesFormat: "BO3",
      maxEntrants: 4,
      entryFee: 0,
      status: "REGISTRATION",
    },
  });
  await prisma.tournamentEntry.createMany({
    data: users.map((userId, i) => ({
      tournamentId: t.id,
      userId,
      seed: i + 1,
      checkedInAt: new Date(),
    })),
  });
  const started = await startTournament(t.id);
  assert(started.started, `tournament start failed: ${started.reason}`);
  // Derive the real ready matchKey from the engine (a 2-player DE bracket's
  // first playable match is not necessarily W1-1).
  const ready = await getReadyTournamentMatches(t.id);
  assert(ready.length === 1, `expected exactly one ready match, got ${ready.length}`);
  const m = ready[0];
  return {
    tournamentId: t.id,
    matchKey: m.matchKey,
    p1: m.player1.id,
    p2: m.player2.id,
  };
}

/** One fake Dolphin: announce on its own socket until the expected reply. */
function announceUntil(
  token: string,
  nonce: string,
  expected: (r: RdvResponse) => boolean,
  attempts = 20
): Promise<{ response: RdvResponse; socket: dgram.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let left = attempts;
    let timer: NodeJS.Timeout;
    socket.on("message", (data) => {
      const response = JSON.parse(data.toString("utf8")) as RdvResponse;
      if (expected(response)) {
        clearInterval(timer);
        resolve({ response, socket });
      }
    });
    const lanPort = () => (socket.address() as { port: number }).port;
    const send = () => {
      if (left-- <= 0) {
        clearInterval(timer);
        socket.close();
        reject(new Error(`no expected reply for nonce ${nonce}`));
        return;
      }
      const msg = JSON.stringify({
        t: "announce",
        v: 1,
        tok: token,
        nonce,
        lan: `127.0.0.1:${lanPort()}`,
      });
      socket.send(msg, PORT, "127.0.0.1");
    };
    socket.bind(0, () => {
      send();
      timer = setInterval(send, 300);
    });
  });
}

async function main() {
  // Re-runnable: clear previous smoke tournaments (users are upserted).
  const old = await prisma.tournament.findMany({ where: { name: { startsWith: NAME } } });
  for (const t of old) {
    await prisma.tournamentMatch.deleteMany({ where: { tournamentId: t.id } });
    await prisma.tournamentEntry.deleteMany({ where: { tournamentId: t.id } });
    await prisma.tournament.delete({ where: { id: t.id } });
  }

  const log = {
    info: (_o: object, m: string) => console.log(`  [registrar] ${m}`),
    warn: (o: object, m: string) => console.log(`  [registrar] ${m} ${JSON.stringify(o)}`),
  };
  const registrar = startUdpRegistrar(PORT, log);

  // --- 1. idempotent minting ----------------------------------------------
  const a = await makeReadyMatch("A");
  const t1 = await getOrCreateRendezvous(a.tournamentId, a.matchKey, a.p1, a.p2, a.p1);
  const t1again = await getOrCreateRendezvous(a.tournamentId, a.matchKey, a.p1, a.p2, a.p1);
  const t2 = await getOrCreateRendezvous(a.tournamentId, a.matchKey, a.p1, a.p2, a.p2);
  assert(t1 && t2 && t1again, "mint returned null");
  assert(t1.token === t1again.token, "re-poll returned a different token (not idempotent)");
  assert(t1.token !== t2.token, "both players got the same token");
  assert(t1.isDecider && t1.playerIndex === 0, "p1 must be decider/index 0");
  assert(!t2.isDecider && t2.playerIndex === 1, "p2 must be non-decider/index 1");
  console.log("OK 1: idempotent minting + slot identity");

  // --- 2. both clients pair over real UDP ---------------------------------
  const [c1, c2] = await Promise.all([
    announceUntil(t1.token, "smokeaaa", (r) => r.t === "peer"),
    announceUntil(t2.token, "smokebbb", (r) => r.t === "peer"),
  ]);
  const p1r = c1.response, p2r = c2.response;
  assert(p1r.t === "peer" && p2r.t === "peer", "expected peer responses");
  assert(p1r.decider && p1r.idx === 0 && !p2r.decider && p2r.idx === 1, "peer slot identity wrong");
  assert(p1r.matchId === t1.matchId && p2r.matchId === t1.matchId, "matchId mismatch");
  assert(p1r.nonce === "smokeaaa" && p1r.pnonce === "smokebbb", "nonce echo wrong");
  assert(p1r.ext.startsWith("127.0.0.1:"), "observed ext should be loopback in smoke");
  c1.socket.close();
  c2.socket.close();
  console.log("OK 2: two UDP clients paired (peer endpoints + nonces verified)");

  // --- 3. lifecycle invariant A: result reported → cannot pair ------------
  await reportTournamentResult(a.tournamentId, a.matchKey, a.p1);
  const after = await announceUntil(
    t1.token,
    "smokeccc",
    (r) => r.t === "err" && r.code === "invalidated"
  );
  after.socket.close();
  console.log("OK 3: reported match answers invalidated — pairing impossible");

  // --- 4. lifecycle invariant B: DQ → cannot pair --------------------------
  const b = await makeReadyMatch("B");
  const tb1 = await getOrCreateRendezvous(b.tournamentId, b.matchKey, b.p1, b.p2, b.p1);
  assert(tb1, "mint B returned null");
  await dqTournamentEntry(b.tournamentId, b.p2); // forfeits W1-1 via cascade
  const afterDq = await announceUntil(
    tb1.token,
    "smokeddd",
    (r) => r.t === "err" && r.code === "invalidated"
  );
  afterDq.socket.close();
  console.log("OK 4: DQ'd match answers invalidated — pairing impossible");

  registrar.close();
  console.log("SMOKE PASSED: rendezvous Phase-0 gate green");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    redis.disconnect();
    // Failure paths may leave the registrar socket (or a client timer) open,
    // which would keep the process alive holding the port — exit decisively.
    setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
  });
