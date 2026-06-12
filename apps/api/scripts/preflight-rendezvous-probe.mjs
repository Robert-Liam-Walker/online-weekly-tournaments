// Prod rendezvous network preflight (run from OUTSIDE the cloud):
//
//   node scripts/preflight-rendezvous-probe.mjs rdv.randallsnightly.com 41100
//
// Sends a schema-valid announce with a bogus token. The registrar answers
// well-formed announces — even unknown tokens — with an error reply
// (silent drops are reserved for malformed packets, the anti-reflector
// rule), so receiving {t:"err"} here proves the full path end to end:
// DNS -> security group -> EB compose port mapping -> registrar listener
// -> UDP return path. No accounts or seed data needed.
import dgram from "node:dgram";

const host = process.argv[2] ?? "rdv.randallsnightly.com";
const port = Number(process.argv[3] ?? "41100");

const probe = JSON.stringify({
  t: "announce",
  v: 1,
  tok: "0".repeat(32), // syntactically valid, guaranteed unknown
  nonce: "preflight" + Math.random().toString(36).slice(2, 8),
  lan: "192.168.1.2:50000", // schema-valid private endpoint
});

const socket = dgram.createSocket("udp4");
const deadline = setTimeout(() => {
  console.error(`FAIL: no reply from ${host}:${port} within 5s — packet lost`);
  console.error("(check SG ingress, EB compose UDP mapping, RENDEZVOUS_UDP_PORT env, app logs)");
  process.exit(1);
}, 5000);

socket.on("message", (data, rinfo) => {
  clearTimeout(deadline);
  console.log(`reply from ${rinfo.address}:${rinfo.port}: ${data.toString("utf8")}`);
  try {
    const parsed = JSON.parse(data.toString("utf8"));
    if (parsed.t === "err") {
      console.log("PASS: registrar reachable end to end (expected error reply for the bogus token)");
      process.exit(0);
    }
    console.error("FAIL: unexpected reply shape");
    process.exit(1);
  } catch {
    console.error("FAIL: non-JSON reply");
    process.exit(1);
  }
});

socket.send(probe, port, host, (err) => {
  if (err) {
    console.error(`FAIL: send error: ${err}`);
    process.exit(1);
  }
  console.log(`announce sent to ${host}:${port}, waiting for reply...`);
});
