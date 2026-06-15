/**
 * Release-channel CLI for the launcher manifest (candidate -> stable).
 * Immutable per-release snapshots + pointer promotion/rollback — see
 * lib/releaseChannels.ts. Promotion/rollback never rebuilds artifacts; it just
 * repoints a channel. The public launcher reads `stable`.
 *
 *   npx tsx apps/api/scripts/release.ts publish --id v2.1.0 \
 *     --dolphin-version 2.1.0 --dolphin-url <gh-asset-url> [--dolphin-sha256 <hex>] \
 *     --gamefiles-version 2.1.0 --gamefiles-url <gh-asset-url> --gamefiles-sha256 <hex> \
 *     [--launcher-min 0.3.0] [--playback-version <v> --playback-url <url>]
 *   npx tsx apps/api/scripts/release.ts promote --channel candidate --release v2.1.0
 *   npx tsx apps/api/scripts/release.ts promote --channel stable    --release v2.1.0
 *   npx tsx apps/api/scripts/release.ts status
 *
 * Env config for the printed links (so they're correct per deployment):
 *   RELEASE_S3_BUCKET                             (where manifests live; store is OFF until set)
 *   S3_REGION | AWS_REGION                        (default us-east-1)
 *   RELEASE_API_BASE | WEB_URL                    (default https://randallsnightly.com)
 *   RELEASE_GH_OWNER                              (default Robert-Liam-Walker)
 */
import {
  type Channel,
  type ReleaseManifest,
  getChannelRelease,
  publishRelease,
  releaseBucket,
  releaseStoreConfigured,
  setChannel,
} from "../src/lib/releaseChannels";

const REGION = process.env.S3_REGION || process.env.AWS_REGION || "us-east-1";
const API_BASE = (
  process.env.RELEASE_API_BASE ||
  process.env.WEB_URL ||
  "https://randallsnightly.com"
).replace(/\/+$/, "");
const GH_OWNER = process.env.RELEASE_GH_OWNER || "Robert-Liam-Walker";

const manifestUrl = (channel: Channel) =>
  channel === "candidate"
    ? `${API_BASE}/api/launcher/manifest?channel=candidate`
    : `${API_BASE}/api/launcher/manifest`;
const s3Console = (key: string) =>
  `https://s3.console.aws.amazon.com/s3/object/${releaseBucket()}?region=${REGION}&prefix=${encodeURIComponent(key)}`;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function requireBucket() {
  if (!releaseStoreConfigured()) {
    die("no release bucket configured — set RELEASE_S3_BUCKET");
  }
}

function buildManifest(a: Record<string, string>): ReleaseManifest {
  const need = (k: string) => a[k] ?? die(`missing --${k}`);
  const netplay = {
    version: need("dolphin-version"),
    win32: need("dolphin-url"),
    ...(a["dolphin-sha256"] ? { sha256: a["dolphin-sha256"] } : {}),
  };
  const playback =
    a["playback-version"] && a["playback-url"]
      ? {
          version: a["playback-version"],
          win32: a["playback-url"],
          ...(a["playback-sha256"] ? { sha256: a["playback-sha256"] } : {}),
        }
      : null;
  return {
    manifestVersion: 1,
    dolphin: { netplay, playback },
    gameFiles: {
      version: need("gamefiles-version"),
      url: need("gamefiles-url"),
      sha256: need("gamefiles-sha256"),
    },
    launcher: a["launcher-min"] ? { minimumVersion: a["launcher-min"] } : null,
  };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);

  switch (cmd) {
    case "publish": {
      requireBucket();
      const id = a.id ?? die("missing --id (the immutable release id, e.g. v2.1.0)");
      const manifest = buildManifest(a);
      await publishRelease(id, manifest);
      console.log(`\npublished immutable snapshot: ${id}`);
      console.log(`  snapshot (S3): ${s3Console(`manifests/releases/${id}.json`)}`);
      console.log(`  dolphin:   ${manifest.dolphin?.netplay?.win32}`);
      console.log(
        `             sha256 ${manifest.dolphin?.netplay?.sha256 ?? "(none)"}  [recorded, NOT enforced by current launcher]`
      );
      if (manifest.dolphin?.playback) console.log(`  playback:  ${manifest.dolphin.playback.win32}`);
      console.log(`  gamefiles: ${manifest.gameFiles?.url}`);
      console.log(`             sha256 ${manifest.gameFiles?.sha256}  [ENFORCED by launcher before extract]`);
      console.log(`\nnext — point a channel at it (test on candidate first):`);
      console.log(`  npx tsx apps/api/scripts/release.ts promote --channel candidate --release ${id}`);
      return;
    }

    case "promote": {
      requireBucket();
      const channel = a.channel as Channel;
      if (channel !== "stable" && channel !== "candidate") die("--channel must be stable|candidate");
      const release = a.release ?? die("missing --release <id>");
      const previous = await getChannelRelease(channel); // capture before repoint, for rollback
      await setChannel(channel, release);
      console.log(`\n${channel} -> ${release}`);
      console.log(`  manifest:        ${manifestUrl(channel)}`);
      console.log(`  channel pointer: ${s3Console(`manifests/channels/${channel}.json`)}`);
      console.log(`  snapshot:        ${s3Console(`manifests/releases/${release}.json`)}`);
      if (previous && previous !== release) {
        console.log(`\nrollback (repoint ${channel} to the previous release):`);
        console.log(`  npx tsx apps/api/scripts/release.ts promote --channel ${channel} --release ${previous}`);
      } else if (!previous) {
        console.log(`\n(${channel} had no previous release — nothing to roll back to yet)`);
      }
      return;
    }

    case "status": {
      requireBucket();
      console.log(`bucket: ${releaseBucket()}  region: ${REGION}`);
      for (const channel of ["stable", "candidate"] as Channel[]) {
        const rel = await getChannelRelease(channel);
        console.log(`  ${channel.padEnd(9)} -> ${rel ?? "(unset)"}   ${manifestUrl(channel)}`);
      }
      console.log(`\ngithub releases:`);
      console.log(`  dolphin/gamefiles: https://github.com/${GH_OWNER}/randalls-dolphin/releases`);
      console.log(`  launcher:          https://github.com/${GH_OWNER}/randalls-launcher/releases`);
      return;
    }

    default:
      die("usage: release.ts <publish|promote|status> [flags]  (see file header)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
