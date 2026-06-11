// Smoke test for push-based tournament updates over Socket.io:
//   npx -w apps/api tsx scripts/smoke-socket.ts
// Requires the dev API running (HTTP on 127.0.0.1:3001, Socket.io on 3002).
// Logs in as WEDE#971 via /auth/game-login, opens an authenticated socket,
// creates a throwaway tournament over HTTP, registers for it, and asserts
// the "tournament:update" {kind:"entry"} broadcast arrives within 5 seconds.
// The throwaway tournament is removed via prisma on both start and finish.

import { io, Socket } from "socket.io-client";
import { prisma } from "../src/lib/prisma";

const API = "http://127.0.0.1:3001/api";
const SOCKET_URL = "http://127.0.0.1:3002";
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

  // 1. Auth — same login the Dolphin client uses
  const login = await http("POST", "/auth/game-login", undefined, { connectCode: "WEDE#971" });
  if (login.status !== 200) throw new Error(`game-login failed (${login.status}): ${JSON.stringify(login.data)}`);
  const token: string = login.data.token;
  console.log(`logged in as ${login.data.user.username} (${login.data.user.connectCode})`);

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
