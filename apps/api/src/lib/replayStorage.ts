import { promises as fs } from "fs";
import path from "path";

// Local dev replay storage (S3 replaces this in prod — keep the surface
// narrow so the swap stays contained to this file). Files land at
//   <repo>/storage/replays/<tournamentId>/<matchKey>-<timestamp>.slp
//
// __dirname is apps/api/src/lib under tsx and apps/api/dist/lib when built —
// both sit two levels below apps/api, so four levels up is the repo root.
const STORAGE_ROOT = process.env.REPLAY_STORAGE_DIR
  ? path.resolve(process.env.REPLAY_STORAGE_DIR)
  : path.resolve(__dirname, "../../../../storage/replays");

// Keep path segments filesystem-safe (params arrive from the URL; the route
// validates them against the DB first, but never trust them as raw paths).
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

export interface StoredReplay {
  // Relative to the repo root, POSIX separators — what we persist in the DB
  // so the storage root can move (or become an S3 key prefix) later.
  storagePath: string;
  absolutePath: string;
}

export async function saveReplayFile(
  tournamentId: string,
  matchKey: string,
  buffer: Buffer
): Promise<StoredReplay> {
  const dirName = safeSegment(tournamentId);
  const fileName = `${safeSegment(matchKey)}-${Date.now()}.slp`;

  const dir = path.join(STORAGE_ROOT, dirName);
  await fs.mkdir(dir, { recursive: true });

  const absolutePath = path.join(dir, fileName);
  await fs.writeFile(absolutePath, buffer);

  return {
    storagePath: path.posix.join("storage", "replays", dirName, fileName),
    absolutePath,
  };
}
