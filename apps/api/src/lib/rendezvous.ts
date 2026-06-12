import { randomBytes } from "crypto";
import { redis } from "./redis";

// Match rendezvous: the backend brokers the UDP connection between the two
// Dolphins of a ready bracket match, replacing Slippi's matchmaking server
// for tournament play. Each player gets a single-match token via the
// authenticated GET /:id/ready poll; both clients fire announce datagrams at
// the UDP registrar (udpRegistrar.ts), which records each client's OBSERVED
// public endpoint and, once both sides are known, answers every announce
// with the opponent's endpoints (simultaneous-connect hole punch).
//
// Invariants (the registrar shell holds NO state — everything lives here,
// in Redis, so any API instance can serve any packet):
//   - State machine: MINTED → P1_ANNOUNCED/P2_ANNOUNCED → PAIRED →
//     INVALIDATED; EXPIRED is the Redis TTL. Slots are the bracket's
//     persisted player1/player2, never arbitrary.
//   - PAIRED is retryable: announces keep being answered with `peer` until
//     invalidation/TTL. One client receiving its response while the other
//     drops a packet must never lock anyone out.
//   - Minting is idempotent per (tournamentId, matchKey): the ~5s /ready
//     poll returns the same token every time while the match is undecided.
//   - Lifecycle: applyResult/DQ/no-show/cancel funnel through
//     invalidateRendezvous, leaving a short tombstone so announcing clients
//     get an explicit `invalidated` error instead of a mystery timeout.
//   - matchKey is the persisted TournamentMatch.matchKey (e.g. "W2-1").

export const RDV_SCHEMA_VERSION = 1;
/** Backstop TTL for a minted rendezvous (refreshed by /ready re-polls). */
const RECORD_TTL_SECONDS = 30 * 60;
/** Tombstone lifetime after invalidation. */
const TOMBSTONE_TTL_SECONDS = 120;
/** An announced endpoint older than this is treated as gone (client died). */
export const ENDPOINT_FRESH_MS = 60_000;

export type RdvSlot = "p1" | "p2";
export type RdvState =
  | "MINTED"
  | "P1_ANNOUNCED"
  | "P2_ANNOUNCED"
  | "PAIRED"
  | "INVALIDATED";

export interface RdvPlayer {
  userId: string;
  token: string;
  nonce?: string;
  /** observed public ip:port (set by the registrar) */
  ext?: string;
  /** client-reported LAN ip:port */
  lan?: string;
  announcedAt?: number;
}

export interface RdvRecord {
  schemaVersion: number;
  state: RdvState;
  tournamentId: string;
  matchKey: string;
  players: { p1: RdvPlayer; p2: RdvPlayer };
  mintedAt: number;
  pairedAt?: number;
  updatedAt: number;
}

/** What the authenticated /ready poll hands the client. */
export interface RdvTicket {
  token: string;
  /** bracket player1 = decider = local player index 0 */
  isDecider: boolean;
  playerIndex: 0 | 1;
  matchId: string;
}

export type RdvResponse =
  | { t: "wait"; you: string }
  | {
      t: "peer";
      you: string;
      ext: string;
      lan: string;
      decider: boolean;
      idx: 0 | 1;
      matchId: string;
      nonce: string;
      pnonce: string;
    }
  | { t: "err"; code: "unknown-token" | "invalidated" | "state-conflict" };

export function rdvMatchId(tournamentId: string, matchKey: string): string {
  return `foxtrot-${tournamentId}-${matchKey}`;
}

function recordKey(tournamentId: string, matchKey: string): string {
  return `foxtrot:rdv:${tournamentId}:${matchKey}`;
}

function tokenKey(token: string): string {
  return `foxtrot:rdv:tok:${token}`;
}

// ---------------------------------------------------------------------------
// Pure core (unit-tested without Redis)
// ---------------------------------------------------------------------------

export function slotOf(record: RdvRecord, userId: string): RdvSlot | null {
  if (record.players.p1.userId === userId) return "p1";
  if (record.players.p2.userId === userId) return "p2";
  return null;
}

function endpointFresh(p: RdvPlayer, now: number): boolean {
  return p.announcedAt != null && now - p.announcedAt <= ENDPOINT_FRESH_MS && !!p.ext;
}

function stateAfterAnnounce(record: RdvRecord, now: number): RdvState {
  const p1Fresh = endpointFresh(record.players.p1, now);
  const p2Fresh = endpointFresh(record.players.p2, now);
  if (p1Fresh && p2Fresh) return "PAIRED";
  if (p1Fresh) return "P1_ANNOUNCED";
  if (p2Fresh) return "P2_ANNOUNCED";
  return "MINTED";
}

/**
 * Apply one validated announce to a record. Returns the updated record and
 * the datagram response. Last-writer-wins per slot: a restarted client's
 * fresh nonce/endpoint simply overwrites its old ones, and the opponent's
 * next announce is answered with the updated endpoint.
 */
export function applyAnnounce(
  record: RdvRecord,
  slot: RdvSlot,
  announce: { nonce: string; ext: string; lan: string },
  now: number
): { record: RdvRecord; response: RdvResponse } {
  if (record.state === "INVALIDATED") {
    return { record, response: { t: "err", code: "invalidated" } };
  }

  const me: RdvPlayer = {
    ...record.players[slot],
    nonce: announce.nonce,
    ext: announce.ext,
    lan: announce.lan,
    announcedAt: now,
  };
  const players = { ...record.players, [slot]: me };
  const next: RdvRecord = {
    ...record,
    players,
    updatedAt: now,
  };
  next.state = stateAfterAnnounce(next, now);
  if (next.state === "PAIRED" && record.state !== "PAIRED") {
    next.pairedAt = now;
  }

  if (next.state !== "PAIRED") {
    return { record: next, response: { t: "wait", you: announce.ext } };
  }

  const opp = next.players[slot === "p1" ? "p2" : "p1"];
  return {
    record: next,
    response: {
      t: "peer",
      you: announce.ext,
      ext: opp.ext!,
      lan: opp.lan ?? "",
      decider: slot === "p1",
      idx: slot === "p1" ? 0 : 1,
      matchId: rdvMatchId(record.tournamentId, record.matchKey),
      nonce: me.nonce!,
      pnonce: opp.nonce ?? "",
    },
  };
}

// ---------------------------------------------------------------------------
// Redis-backed operations
// ---------------------------------------------------------------------------

function mintRecord(
  tournamentId: string,
  matchKey: string,
  p1UserId: string,
  p2UserId: string,
  now: number
): RdvRecord {
  return {
    schemaVersion: RDV_SCHEMA_VERSION,
    state: "MINTED",
    tournamentId,
    matchKey,
    players: {
      p1: { userId: p1UserId, token: randomBytes(16).toString("hex") },
      p2: { userId: p2UserId, token: randomBytes(16).toString("hex") },
    },
    mintedAt: now,
    updatedAt: now,
  };
}

async function saveRecord(record: RdvRecord, ttlSeconds: number): Promise<void> {
  const key = recordKey(record.tournamentId, record.matchKey);
  const slotRef = (slot: RdvSlot) =>
    JSON.stringify({ tournamentId: record.tournamentId, matchKey: record.matchKey, slot });
  await redis
    .multi()
    .set(key, JSON.stringify(record), "EX", ttlSeconds)
    .set(tokenKey(record.players.p1.token), slotRef("p1"), "EX", ttlSeconds)
    .set(tokenKey(record.players.p2.token), slotRef("p2"), "EX", ttlSeconds)
    .exec();
}

async function loadRecord(tournamentId: string, matchKey: string): Promise<RdvRecord | null> {
  const raw = await redis.get(recordKey(tournamentId, matchKey));
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as RdvRecord;
    // Older schema versions are treated as absent and re-minted.
    return record.schemaVersion === RDV_SCHEMA_VERSION ? record : null;
  } catch {
    return null;
  }
}

/**
 * Idempotent mint: returns the viewer's ticket for this ready match,
 * creating the record once and re-serving the same tokens on every poll.
 * If the persisted pairing changed (bracket advanced into the same key with
 * different players — possible after DQ cascades), the stale record is
 * invalidated and a fresh one minted.
 */
export async function getOrCreateRendezvous(
  tournamentId: string,
  matchKey: string,
  p1UserId: string,
  p2UserId: string,
  viewerUserId: string
): Promise<RdvTicket | null> {
  const now = Date.now();
  let record = await loadRecord(tournamentId, matchKey);

  if (
    record &&
    record.state !== "INVALIDATED" &&
    (record.players.p1.userId !== p1UserId || record.players.p2.userId !== p2UserId)
  ) {
    await invalidateRendezvous(tournamentId, matchKey);
    record = null;
  }

  if (!record || record.state === "INVALIDATED") {
    // A tombstone must not block re-minting; clear it first. Announces with
    // the old tokens then resolve to a token mismatch (state-conflict).
    if (record?.state === "INVALIDATED") {
      await redis.del(recordKey(tournamentId, matchKey));
    }
    const fresh = mintRecord(tournamentId, matchKey, p1UserId, p2UserId, now);
    // NX guards the race between two concurrent first polls: loser re-reads.
    const won = await redis.set(
      recordKey(tournamentId, matchKey),
      JSON.stringify(fresh),
      "EX",
      RECORD_TTL_SECONDS,
      "NX"
    );
    if (won === "OK") {
      await saveRecord(fresh, RECORD_TTL_SECONDS);
      record = fresh;
    } else {
      record = await loadRecord(tournamentId, matchKey);
      if (!record) return null;
    }
  } else {
    // Refresh the backstop TTL while the match is still being polled.
    await saveRecord(record, RECORD_TTL_SECONDS);
  }

  const slot = slotOf(record, viewerUserId);
  if (!slot) return null;
  return {
    token: record.players[slot].token,
    isDecider: slot === "p1",
    playerIndex: slot === "p1" ? 0 : 1,
    matchId: rdvMatchId(tournamentId, matchKey),
  };
}

/**
 * Handle one validated announce datagram (called by the registrar shell).
 * Resolves the token, applies the transition, persists, responds.
 */
export async function handleAnnounce(
  token: string,
  announce: { nonce: string; ext: string; lan: string }
): Promise<RdvResponse> {
  const refRaw = await redis.get(tokenKey(token));
  if (!refRaw) return { t: "err", code: "unknown-token" };

  let ref: { tournamentId: string; matchKey: string; slot: RdvSlot };
  try {
    ref = JSON.parse(refRaw);
  } catch {
    return { t: "err", code: "unknown-token" };
  }

  const record = await loadRecord(ref.tournamentId, ref.matchKey);
  if (!record) return { t: "err", code: "unknown-token" };
  // The token map and the record must agree (re-mint replaces both).
  if (record.players[ref.slot].token !== token) {
    return { t: "err", code: "state-conflict" };
  }

  const { record: next, response } = applyAnnounce(record, ref.slot, announce, Date.now());
  if (response.t !== "err") {
    const ttl = await redis.ttl(recordKey(ref.tournamentId, ref.matchKey));
    await redis.set(
      recordKey(ref.tournamentId, ref.matchKey),
      JSON.stringify(next),
      "EX",
      ttl > 0 ? ttl : RECORD_TTL_SECONDS
    );
  }
  return response;
}

/**
 * Kill a match's rendezvous (result reported, DQ, no-show advance, cancel).
 * Leaves a short tombstone so in-flight clients get an explicit
 * `invalidated` error rather than a silent unknown-token.
 */
export async function invalidateRendezvous(
  tournamentId: string,
  matchKey: string
): Promise<void> {
  const record = await loadRecord(tournamentId, matchKey);
  if (!record) return;
  const tombstone: RdvRecord = {
    ...record,
    state: "INVALIDATED",
    updatedAt: Date.now(),
  };
  await saveRecord(tombstone, TOMBSTONE_TTL_SECONDS);
}

/** True when the deployment serves rendezvous (host + port configured). */
export function rendezvousConfig(): { udpHost: string; udpPort: number } | null {
  const host = process.env.RENDEZVOUS_HOST;
  const port = Number(process.env.RENDEZVOUS_UDP_PORT);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { udpHost: host, udpPort: port };
}
