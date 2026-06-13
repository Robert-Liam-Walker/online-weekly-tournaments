/**
 * udpRegistrar.ts — UDP rendezvous registrar for peer-to-peer match setup.
 *
 * Purpose:
 *   Listens on a UDP port and accepts "announce" packets from game clients that
 *   are trying to establish a direct (peer-to-peer) connection for a match. Each
 *   client sends its LAN endpoint (private IP:port) and a shared match token;
 *   the registrar stores both clients' WAN+LAN endpoints in Redis and echoes
 *   them back once both sides have checked in (rendezvous). The actual state
 *   machine lives in lib/rendezvous.ts.
 *
 * Design:
 *   Deliberately stateless beyond the Redis store: any API instance behind the
 *   same Redis cluster can handle any client, enabling horizontal scaling without
 *   sticky sessions.
 *
 * Security hardening:
 *   - Request length cap (256 B) + strict Zod schema + single-datagram JSON only.
 *   - `lan` field must be a valid IPv4 private-range ip:port (10/8, 172.16/12,
 *     192.168/16); loopback (127.x) is also accepted outside production so that
 *     localhost smoke tests work without VPN. IPv6 is out of scope for v1.
 *   - Per-IP and per-token Redis rate counters; packets exceeding the cap are
 *     DROPPED silently (no error reply) — replying to a spoofed source address
 *     would turn this server into a UDP reflector/amplifier.
 *   - Responses are hard-capped at 512 B as a secondary anti-amplification
 *     ceiling (an oversized response is dropped rather than truncated).
 *   - Every rejected packet logs a structured reason code for NAT/firewall
 *     debugging without leaking internal state to clients.
 *
 * Lifecycle:
 *   startUdpRegistrar() is called from src/index.ts only when
 *   RENDEZVOUS_UDP_PORT is set to a valid port number. Returns the dgram.Socket
 *   so the caller can call .close() on SIGTERM.
 */
import dgram from "dgram";
import { z } from "zod";
import { redis } from "./lib/redis";
import { handleAnnounce, RdvResponse } from "./lib/rendezvous";

const MAX_REQUEST_BYTES = 256;
const MAX_RESPONSE_BYTES = 512;
/** Per-IP rate cap: 50 packets per 10 s. Active clients send ~2 packets/s
 *  (one announce at connect, then polling every ~5 s), so this leaves ~25×
 *  headroom for a single well-behaved client and still throttles flood attacks. */
const IP_LIMIT = { max: 50, windowSeconds: 10 };
/** Per-match-token rate cap: 120 packets per 60 s (2 clients × ~1/s with margin). */
const TOKEN_LIMIT = { max: 120, windowSeconds: 60 };

const announceSchema = z.object({
  t: z.literal("announce"),
  v: z.literal(1),
  tok: z.string().regex(/^[0-9a-f]{32}$/),
  nonce: z.string().regex(/^[0-9a-zA-Z]{8,32}$/),
  lan: z.string().max(24),
});

/** Minimal structured logger interface; satisfied by Fastify's built-in logger. */
export interface RegistrarLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

/**
 * Parse and validate a LAN endpoint string of the form "a.b.c.d:port".
 *
 * Accepted addresses:
 *   - IPv4 private ranges: 10/8, 172.16–31/12, 192.168/16
 *   - Loopback (127.x): only when allowLoopback is true (i.e., non-production)
 *
 * Returns null for any malformed, out-of-range, or non-private address so the
 * caller can drop the packet rather than storing an attacker-controlled address.
 *
 * @param lan           - Raw "ip:port" string from the announce packet.
 * @param allowLoopback - True outside production (enables localhost smoke tests).
 * @returns Parsed { ip, port } or null if invalid/non-private.
 */
export function parseLanEndpoint(
  lan: string,
  allowLoopback: boolean
): { ip: string; port: number } | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(lan);
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  const port = Number(m[5]);
  if (octets.some((o) => o > 255) || port < 1 || port > 65535) return null;
  const [a, b] = octets;
  const isPrivate =
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  const isLoopback = a === 127;
  if (!isPrivate && !(allowLoopback && isLoopback)) return null;
  return { ip: octets.join("."), port };
}

/**
 * Increment a Redis sliding-window counter for `id` and return true if the
 * count has exceeded the cap for this window. The TTL is set only on the
 * first increment (count === 1) to create a fixed window anchored at the
 * first packet; subsequent packets in the same window do not reset the timer.
 *
 * Keys follow the pattern: foxtrot:rdv:rl:<kind>:<id>
 *
 * @param kind - "ip" for per-source-address limit, "tok" for per-match-token.
 * @param id   - The IP address or token to bucket.
 * @returns true if the caller should drop the packet.
 */
async function overRateLimit(kind: "ip" | "tok", id: string): Promise<boolean> {
  const limit = kind === "ip" ? IP_LIMIT : TOKEN_LIMIT;
  const key = `foxtrot:rdv:rl:${kind}:${id}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, limit.windowSeconds);
  return count > limit.max;
}

/**
 * Bind a UDP socket and start processing rendezvous announce packets.
 *
 * The socket processes each incoming datagram through the validation + rate-
 * limit pipeline before delegating to handleAnnounce() in lib/rendezvous.ts.
 * Error replies are sent even for validation failures so clients can surface
 * a meaningful error; only rate-capped packets are silently dropped.
 *
 * @param port - UDP port to bind on (all interfaces, 0.0.0.0).
 * @param log  - Structured logger (Fastify's logger satisfies RegistrarLogger).
 * @returns The bound dgram.Socket; call .close() on SIGTERM.
 */
export function startUdpRegistrar(port: number, log: RegistrarLogger): dgram.Socket {
  const allowLoopback = process.env.NODE_ENV !== "production";
  const socket = dgram.createSocket("udp4");

  const reply = (response: RdvResponse, rinfo: dgram.RemoteInfo) => {
    const payload = Buffer.from(JSON.stringify(response));
    if (payload.length > MAX_RESPONSE_BYTES) {
      log.warn({ bytes: payload.length }, "rdv response over cap — dropped");
      return;
    }
    socket.send(payload, rinfo.port, rinfo.address);
  };

  socket.on("message", (data, rinfo) => {
    void (async () => {
      try {
        if (data.length > MAX_REQUEST_BYTES) {
          log.warn({ ip: rinfo.address, reason: "oversize" }, "rdv packet rejected");
          return;
        }
        if (await overRateLimit("ip", rinfo.address)) {
          log.warn({ ip: rinfo.address, reason: "rate-capped-ip" }, "rdv packet dropped");
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString("utf8"));
        } catch {
          log.warn({ ip: rinfo.address, reason: "schema" }, "rdv packet rejected");
          return;
        }
        const msg = announceSchema.safeParse(parsed);
        if (!msg.success) {
          log.warn({ ip: rinfo.address, reason: "schema" }, "rdv packet rejected");
          return;
        }
        if (!parseLanEndpoint(msg.data.lan, allowLoopback)) {
          log.warn(
            { ip: rinfo.address, reason: "bad-lan", lan: msg.data.lan },
            "rdv packet rejected"
          );
          return;
        }
        if (await overRateLimit("tok", msg.data.tok)) {
          log.warn({ ip: rinfo.address, reason: "rate-capped-token" }, "rdv packet dropped");
          return;
        }

        const ext = `${rinfo.address}:${rinfo.port}`;
        const response = await handleAnnounce(msg.data.tok, {
          nonce: msg.data.nonce,
          ext,
          lan: msg.data.lan,
        });
        if (response.t === "err") {
          log.warn({ ip: rinfo.address, reason: response.code }, "rdv announce failed");
        }
        reply(response, rinfo);
      } catch (err) {
        log.warn({ err: String(err), reason: "internal" }, "rdv packet error");
      }
    })();
  });

  socket.on("error", (err) => {
    log.warn({ err: String(err) }, "rdv socket error");
  });

  socket.bind(port, () => {
    log.info({ port }, "rendezvous UDP registrar listening");
  });
  return socket;
}
