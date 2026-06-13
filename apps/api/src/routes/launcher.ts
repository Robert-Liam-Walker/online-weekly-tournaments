/**
 * routes/launcher.ts — Launcher update manifest endpoint.
 *
 * The FoxTrot launcher polls GET /api/launcher/manifest on startup to discover
 * the latest Dolphin builds, game-file bundle, and the minimum supported
 * launcher version. All values come from environment variables so new builds
 * are rolled out by updating env vars, not by redeploying code.
 *
 * Endpoint:
 *   GET /api/launcher/manifest  — public (no auth). Cached 60 s by CDN/clients.
 *
 * Environment variables read:
 *   FOXTROT_DOLPHIN_VERSION              — netplay Dolphin version string
 *   FOXTROT_DOLPHIN_WIN_URL              — netplay Dolphin Windows download URL
 *   FOXTROT_DOLPHIN_PLAYBACK_VERSION     — playback Dolphin version string
 *   FOXTROT_DOLPHIN_PLAYBACK_WIN_URL     — playback Dolphin Windows download URL
 *   FOXTROT_GAMEFILES_VERSION            — game files bundle version string
 *   FOXTROT_GAMEFILES_URL                — game files bundle download URL
 *   FOXTROT_GAMEFILES_SHA256             — SHA-256 checksum of the game files bundle
 *   FOXTROT_LAUNCHER_MIN_VERSION         — minimum launcher version string
 *
 * Each section (dolphin, gameFiles, launcher) is returned as null when its
 * required variables are absent, so the launcher can skip missing sections
 * rather than failing. The `env()` helper filters out blank/whitespace values.
 */
import { FastifyInstance } from "fastify";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : undefined;
}

export async function launcherRoutes(app: FastifyInstance) {
  /**
   * GET /api/launcher/manifest
   * Auth: public (no JWT required).
   * Response 200 (Cache-Control: public, max-age=60):
   *   {
   *     manifestVersion: 1,
   *     dolphin: {
   *       netplay:  { version, win32 } | null,
   *       playback: { version, win32 } | null,
   *     } | null,
   *     gameFiles: { version, url, sha256 } | null,
   *     launcher:  { minimumVersion } | null,
   *   }
   * All sections are null when their env vars are not set.
   * manifestVersion is a stable integer for forward-compatibility parsing.
   */
  app.get("/manifest", async (_request, reply) => {
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

    reply.header("Cache-Control", "public, max-age=60");
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
