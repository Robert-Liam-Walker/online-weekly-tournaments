import dgram from "dgram";
import { z } from "zod";
import { redis } from "./lib/redis";
import { handleAnnounce, RdvResponse } from "./lib/rendezvous";

// UDP shell for the match rendezvous (see lib/rendezvous.ts for the state
// machine). Deliberately stateless: every packet is resolved against Redis,
// so any API instance behind the same Redis can serve any client.
//
// Hardening:
//   - request length cap (256B) + strict zod schema, single-datagram JSON
//   - `lan` must be a valid IPv4 private-range ip:port (loopback allowed
//     outside production so localhost smokes work); IPv6 out of scope v1
//   - per-IP and per-token rate caps (Redis counters); over-cap packets are
//     DROPPED, not answered — an error reply to a spoofed source address
//     would make us a reflector
//   - responses are hard-capped at 512B (anti-amplification ceiling)
//   - every rejected packet logs a reason code so NAT debugging is tractable

const MAX_REQUEST_BYTES = 256;
const MAX_RESPONSE_BYTES = 512;
/** per-IP: 50 packets / 10s (an active client sends ~2/s) */
const IP_LIMIT = { max: 50, windowSeconds: 10 };
/** per-token: 120 packets / 60s */
const TOKEN_LIMIT = { max: 120, windowSeconds: 60 };

const announceSchema = z.object({
  t: z.literal("announce"),
  v: z.literal(1),
  tok: z.string().regex(/^[0-9a-f]{32}$/),
  nonce: z.string().regex(/^[0-9a-zA-Z]{8,32}$/),
  lan: z.string().max(24),
});

export interface RegistrarLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

/** "a.b.c.d:port" with an IPv4 private-range (or dev loopback) address. */
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

async function overRateLimit(kind: "ip" | "tok", id: string): Promise<boolean> {
  const limit = kind === "ip" ? IP_LIMIT : TOKEN_LIMIT;
  const key = `foxtrot:rdv:rl:${kind}:${id}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, limit.windowSeconds);
  return count > limit.max;
}

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
