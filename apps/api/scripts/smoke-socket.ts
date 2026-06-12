import "dotenv/config"; // load apps/api/.env when run standalone (run from apps/api/)
// Smoke test for push-based tournament updates over Socket.io:
//   npx -w apps/api tsx scripts/smoke-socket.ts
// Requires the dev API running (HTTP + Socket.io share port 3001).
// Mints a dev JWT for the seeded "robert" user, opens an authenticated socket,
// creates a throwaway tournament over HTTP, registers for it, and asserts
// the "tournament:update" {kind:"entry"} broadcast arrives within 5 seconds.
// The throwaway tournament is removed via prisma on both start and finish.

import { createHmac } from "crypto";
import { io, Socket } from "socket.io-client";
import { prisma } from "../src/lib/prisma";

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

const API = "http://127.0.0.1:3001/api";
const SOCKET_URL = "http://127.0.0.1:3001"; // Socket.io rides the API port
const NAME = "Socket Smoke (disposable)";
const EVENT_TIMEOUT_MS = 5000;

type UpdatePayload = { tournamentId: string; kind: string };

async function http(
  method: string,
  path: string,
  token?: string,
  body?: unknown
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function cleanup() {
  const leftovers = await prisma.tournament.findMany({ where: { name: NAME } });
  for (const t of leftovers) {
    await prisma.tournamentEntry.deleteMany({ where: { tournamentId: t.id } });
    await prisma.tournament.delete({ where: { id: t.id } });
  }
  if (leftovers.length > 0) console.log(`cleaned up ${leftovers.length} throwaway tournament(s)`);
}

function connectSocket(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(SOCKET_URL, { auth: { token } });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error("socket did not connect within 5s"));
    }, 5000);
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on("connect_error", (err) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(new Error(`socket connect_error: ${err.message}`));
    });
  });
}

function waitForUpdate(socket: Socket, tournamentId: string): Promise<UpdatePayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no tournament:update for ${tournamentId} within ${EVENT_TIMEOUT_MS}ms`)),
      EVENT_TIMEOUT_MS
    );
    const handler = (payload: UpdatePayload) => {
      if (payload?.tournamentId !== tournamentId) return; // other events may fire
      clearTimeout(timer);
      socket.off("tournament:update", handler);
      resolve(payload);
    };
    socket.on("tournament:update", handler);
  });
}

async function main() {
  await cleanup();

  // 1. Auth — mint a dev token for the seeded user
  const username = process.env.SEED_USERNAME ?? "robert";
  const me = await prisma.user.findUnique({ where: { username } });
  if (!me) throw new Error(`user ${username} missing - run seed-dev-events.ts first`);
  const token = mintToken(me.id);
  console.log(`minted dev token for ${me.username}`);

  // 2. Socket
  const socket = await connectSocket(token);
  console.log(`socket connected: ${socket.id}`);

  try {
    // 3. Throwaway tournament (free, far in the future so nothing auto-starts it)
    const created = await http("POST", "/tournaments", token, {
      name: NAME,
      description: "smoke-socket.ts throwaway — safe to delete",
      scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      entryFee: 0,
    });
    if (created.status !== 201) throw new Error(`create failed (${created.status}): ${JSON.stringify(created.data)}`);
    const tournamentId: string = created.data.id;
    console.log(`created throwaway tournament ${tournamentId}`);

    // New tournaments default to UPCOMING; open registration so the register
    // mutation succeeds (same flip the scheduler does for weeklies).
    await prisma.tournament.update({
      where: { id: tournamentId },
      data: { status: "REGISTRATION" },
    });

    // 4. Listen first, then trigger the mutation
    const eventPromise = waitForUpdate(socket, tournamentId);
    eventPromise.catch(() => {}); // mark handled in case register throws first
    const start = Date.now();
    const reg = await http("POST", `/tournaments/${tournamentId}/register`, token);
    if (reg.status !== 201) throw new Error(`register failed (${reg.status}): ${JSON.stringify(reg.data)}`);

    const payload = await eventPromise;
    const elapsed = Date.now() - start;
    console.log(`received tournament:update ${JSON.stringify(payload)} after ${elapsed}ms`);

    if (payload.kind !== "entry") throw new Error(`expected kind "entry", got "${payload.kind}"`);
    console.log("OK: tournament:update push event verified");
  } finally {
    socket.disconnect();
    await cleanup();
  }
}

// No process.exit(): on Windows it races libuv handle teardown (tsx +
// socket.io). Let the loop drain after disconnects; set exitCode on failure.
main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
