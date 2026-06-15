import { FastifyInstance } from "fastify";
import {
  getChannelManifest,
  releaseStoreConfigured,
  type Channel,
} from "../lib/releaseChannels";

// Public manifest the FoxTrot launcher polls to discover the current Dolphin
// builds, game-file bundle, and minimum supported launcher version.
//
// Every value comes from the environment so releases are cut by updating env
// vars, not redeploying code:
//   FOXTROT_DOLPHIN_VERSION / FOXTROT_DOLPHIN_WIN_URL                (netplay)
//   FOXTROT_DOLPHIN_PLAYBACK_VERSION / FOXTROT_DOLPHIN_PLAYBACK_WIN_URL
//   FOXTROT_GAMEFILES_VERSION / FOXTROT_GAMEFILES_URL / FOXTROT_GAMEFILES_SHA256
//   FOXTROT_LAUNCHER_MIN_VERSION
// Any section whose variables are missing is returned as null so the launcher
// can skip it cleanly.

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : undefined;
}

export async function launcherRoutes(app: FastifyInstance) {
  app.get("/manifest", async (request, reply) => {
    reply.header("Cache-Control", "public, max-age=60");

    // Candidate/stable channels (S3-backed, immutable snapshots). Public
    // launchers send nothing -> stable; our candidate fresh-install E2E sets
    // FOXTROT_CHANNEL so the launcher requests ?channel=candidate. Falls
    // through to the env-var manifest below when the S3 release store isn't
    // configured or the channel has no release pointer yet (keeps dev and the
    // current prod behavior working).
    const channel: Channel =
      (request.query as { channel?: string }).channel === "candidate"
        ? "candidate"
        : "stable";
    if (releaseStoreConfigured()) {
      const fromChannel = await getChannelManifest(channel);
      if (fromChannel) return fromChannel;
    }

    const netplayVersion = env("FOXTROT_DOLPHIN_VERSION");
    const netplayWin32 = env("FOXTROT_DOLPHIN_WIN_URL");
    const playbackVersion = env("FOXTROT_DOLPHIN_PLAYBACK_VERSION");
    const playbackWin32 = env("FOXTROT_DOLPHIN_PLAYBACK_WIN_URL");
    const gameFilesVersion = env("FOXTROT_GAMEFILES_VERSION");
    const gameFilesUrl = env("FOXTROT_GAMEFILES_URL");
    const gameFilesSha256 = env("FOXTROT_GAMEFILES_SHA256");
    const launcherMinVersion = env("FOXTROT_LAUNCHER_MIN_VERSION");

    const netplay =
      netplayVersion && netplayWin32
        ? { version: netplayVersion, win32: netplayWin32 }
        : null;
    const playback =
      playbackVersion && playbackWin32
        ? { version: playbackVersion, win32: playbackWin32 }
        : null;

    return {
      manifestVersion: 1,
      dolphin: netplay || playback ? { netplay, playback } : null,
      gameFiles:
        gameFilesVersion && gameFilesUrl && gameFilesSha256
          ? {
              version: gameFilesVersion,
              url: gameFilesUrl,
              sha256: gameFilesSha256,
            }
          : null,
      launcher: launcherMinVersion
        ? { minimumVersion: launcherMinVersion }
        : null,
    };
  });
}
