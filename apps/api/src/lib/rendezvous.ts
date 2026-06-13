/**
 * rendezvous.ts — UDP match-rendezvous state machine, Redis-backed.
 *
 * Purpose: Broker the UDP hole-punch connection between the two Dolphin clients
 * for a ready bracket match, replacing Slippi's cloud matchmaking for tournament
 * play. Each player gets a single-match token via the authenticated GET
 * /:id/ready poll; both clients fire "announce" datagrams at the UDP registrar
 * (udpRegistrar.ts), which records each client's OBSERVED public endpoint and,
 * once both are known, answers every announce with the opponent's endpoint
 * (simultaneous-connect hole punch).
 *
 * Architecture:
 *   The UDP registrar shell holds NO state — everything lives in Redis, so any
 *   API instance can serve any UDP packet. The registrar calls handleAnnounce()
 *   here; this module owns the full state machine.
 *
 * State machine: MINTED → P1_ANNOUNCED | P2_ANNOUNCED → PAIRED → INVALIDATED
 *   EXPIRED is implicit (Redis TTL). Transitions:
 *     MINTED        — record created; no announce received yet.
 *     P1_ANNOUNCED  — player 1 has announced a fresh endpoint.
 *     P2_ANNOUNCED  — player 2 has announced a fresh endpoint.
 *     PAIRED        — both players have fresh endpoints; each announce is answered
 *                     with the opponent's ext/lan. PAIRED is retryable: repeated
 *                     announces from either player continue to receive peer responses
 *                     until invalidation or TTL.
 *     INVALIDATED   — result/DQ/no-show/cancel has ended the match. A short
 *                     tombstone (TOMBSTONE_TTL_SECONDS) remains so in-flight
 *                     clients get an explicit `invalidated` error instead of a
 *                     mystery unknown-token.
 *
 * Idempotency:
 *   - Minting is idempotent per (tournamentId, matchKey): the /ready poll returns
 *     the same token every time while the match is undecided. An NX guard on the
 *     Redis SET protects the concurrent-first-poll race; the loser re-reads.
 *   - If the bracket advances into the same matchKey with different players (e.g.
 *     after a DQ cascade), the stale record is invalidated and a fresh one minted.
 *   - A restarted client overwrites its own slot (last-writer-wins per slot); the
 *     opponent's next announce receives the updated endpoint.
 *
 * matchKey semantics:
 *   matchKey is the persisted TournamentMatch.matchKey (e.g. "W2-1", "GF").
 *   Slots p1/p2 correspond to TournamentMatch.player1Id/player2Id (bracket order,
 *   not connection order). p1 is the "decider" (local player index 0 in Dolphin).
 *
 * Redis keys:
 *   foxtrot:rdv:<tournamentId>:<matchKey>  — the RdvRecord JSON blob.
 *   foxtrot:rdv:tok:<token>                — token → {tournamentId, matchKey, slot}
 *                                            reverse-lookup, same TTL as the record.
 *
 * Key exports:
 *   getOrCreateRendezvous — idempotent mint; returns the viewer's RdvTicket.
 *   handleAnnounce        — process one validated announce datagram.
 *   invalidateRendezvous  — kill a match's rendezvous (result/DQ/cancel).
 *   applyAnnounce         — pure core (unit-tested without Redis).
 *   rendezvousConfig      — read RENDEZVOUS_HOST + RENDEZVOUS_UDP_PORT from env.
 *   RdvRecord / RdvTicket / RdvResponse / RdvState / RdvSlot — types.
 *   RDV_SCHEMA_VERSION    — current record schema version (stale records re-minted).
 *   ENDPOINT_FRESH_MS     — endpoint freshness window (60 s).
 *
 * Invariants:
 *   - Announces keep being answered with `peer` responses after PAIRED — one
 *     client dropping a UDP packet must never lock the other out.
 *   - Every result / DQ / no-show / cancel path must call invalidateRendezvous
 *     so clients get an explicit `invalidated` response rather than a timeout.
 *   - The tombstone (INVALIDATED + 120 s TTL) must outlive the longest expected
 *     client retry window.
 *   - Schema version bump: if RdvRecord fields change incompatibly, bump
 *     RDV_SCHEMA_VERSION; loadRecord will treat old records as absent and
 *     re-mint, preventing deserialization surprises.
 */
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

/**
 * Compose the Dolphin matchId string for a tournament match.
 * Used by both the /ready poll response and the rendezvous peer response.
 * @param tournamentId - the tournament.
 * @param matchKey     - the bracket match key (e.g. "W2-1").
 */
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

/**
 * Return the slot ("p1" | "p2") that userId occupies in the record, or null.
 */
export function slotOf(record: RdvRecord, userId: string): RdvSlot | null {
  if (record.players.p1.userId === userId) return "p1";
  if (record.players.p2.userId === userId) return "p2";
  return null;
}

/** True if player p has a fresh (within ENDPOINT_FRESH_MS) announced endpoint. */
function endpointFresh(p: RdvPlayer, now: number): boolean {
  return p.announcedAt != null && now - p.announcedAt <= ENDPOINT_FRESH_MS && !!p.ext;
}

/** Derive the next state from which players have fresh endpoints. */
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
 *
 * @param record   - current record loaded from Redis.
 * @param slot     - which slot ("p1" | "p2") is announcing.
 * @param announce - the nonce, observed public endpoint (ext), and LAN endpoint.
 * @param now      - current epoch ms (injected for unit-testability).
 * @returns Updated record and the response to send back in the datagram.
 *
 * Pure — no Redis side effects. The caller (handleAnnounce) persists the
 * updated record.
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

/**
 * Persist a record and its two token→slot reverse-lookup keys atomically.
 * All three keys get the same TTL so they expire together.
 */
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

/**
 * Load a record from Redis. Returns null on missing or unparseable JSON.
 * Records with an older schemaVersion are treated as absent and will be
 * re-minted, preventing deserialization surprises on schema changes.
 */
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
 *
 * @param tournamentId - the tournament.
 * @param matchKey     - the bracket match key.
 * @param p1UserId     - player 1 (bracket slot) user ID.
 * @param p2UserId     - player 2 (bracket slot) user ID.
 * @param viewerUserId - the authenticated user requesting the ticket.
 * @returns An RdvTicket for viewerUserId, or null if they are not in this match.
 *
 * An NX guard on the initial SET protects the concurrent-first-poll race:
 * the losing writer re-reads the winner's record rather than overwriting it.
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
 * Resolves the token to a slot, applies the state transition, persists the
 * updated record, and returns the datagram response.
 *
 * @param token    - the per-player token returned by getOrCreateRendezvous.
 * @param announce - nonce, observed public endpoint, and client-reported LAN endpoint.
 * @returns RdvResponse: "wait" (one side known), "peer" (both known), or "err".
 *
 * The TTL is preserved from the existing record rather than reset on each
 * announce, so the backstop expiry is anchored to minting/poll time.
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
    // Preserve existing TTL rather than resetting on every announce.
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
 * Invalidate a match's rendezvous (result reported, DQ, no-show advance, cancel).
 * Leaves a short tombstone (TOMBSTONE_TTL_SECONDS = 120 s) so in-flight clients
 * get an explicit `invalidated` error rather than a silent unknown-token.
 *
 * @param tournamentId - the tournament.
 * @param matchKey     - the bracket match key to invalidate.
 *
 * No-op if no record exists for the match (already expired or never minted).
 * Must be called by every code path that ends a match: applyResult in
 * bracketService, DQ cascades, no-show sweeps, and tournament cancellation.
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

/**
 * Read rendezvous host/port configuration from environment variables.
 * @returns {udpHost, udpPort} if both are valid, null otherwise.
 *
 * Used by bracketService.getReadyTournamentMatches to decide whether to
 * attach rendezvous tickets to ready-match responses. When null, the UDP
 * rendezvous feature is disabled for this deployment.
 */
export function rendezvousConfig(): { udpHost: string; udpPort: number } | null {
  const host = process.env.RENDEZVOUS_HOST;
  const port = Number(process.env.RENDEZVOUS_UDP_PORT);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { udpHost: host, udpPort: port };
}
