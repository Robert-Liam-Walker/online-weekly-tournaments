/**
 * replayStorage.ts — Slippi replay file storage with S3 and local-disk backends.
 *
 * Purpose: Persist uploaded .slp replay files and retrieve them later for the
 * replay-download endpoint. Two backends behind one narrow surface, selected by
 * the presence of S3_BUCKET:
 *
 *   S3 (production): active when S3_BUCKET is set. Objects are stored at:
 *       replays/<tournamentId>/<matchKey>-<timestamp>.slp
 *     Credentials come from the default AWS provider chain (env vars, shared
 *     config, or the EC2/ECS instance role on Elastic Beanstalk — none are
 *     passed explicitly). S3_ENDPOINT overrides the endpoint for
 *     minio/localstack-style local testing; S3_REGION (or AWS_REGION) sets
 *     the bucket region (default: us-east-1).
 *
 *   Local disk (dev, default): when S3_BUCKET is unset. Files land at:
 *       <repo>/storage/replays/<tournamentId>/<matchKey>-<timestamp>.slp
 *     Override the root with REPLAY_STORAGE_DIR.
 *
 * Storage path format:
 *   The DB persists StoredReplay.storagePath so the storage root can move (or
 *   become an S3 key prefix) after deployment. The two backends are
 *   distinguishable per DB row:
 *     - Local rows:  "storage/replays/<dir>/<file>.slp"  (starts with LOCAL_PREFIX)
 *     - S3 rows:     "replays/<dir>/<file>.slp"           (bare S3 object key)
 *   readReplayFile() handles both prefixes, so legacy local rows keep working
 *   after S3 is switched on.
 *
 * Path safety:
 *   tournamentId and matchKey arrive from the URL; although routes validate them
 *   against the DB first, safeSegment() strips anything outside [A-Za-z0-9_-]
 *   before forming filesystem paths or S3 keys.
 *
 * __dirname note:
 *   Under tsx (development) __dirname is apps/api/src/lib; under tsc (build)
 *   it is apps/api/dist/lib. Both are four levels below the repo root, so the
 *   STORAGE_ROOT path resolution (../../../../storage/replays) is correct in
 *   both environments. REPLAY_STORAGE_DIR overrides this entirely.
 *
 * Key exports:
 *   saveReplayFile  — store a .slp buffer; returns storagePath + absolutePath.
 *   readReplayFile  — fetch a previously stored replay by its storagePath.
 *   StoredReplay    — shape of the value returned by saveReplayFile.
 */
import { promises as fs } from "fs";
import path from "path";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

// Replay storage with two backends behind one narrow surface:
//
//   - S3 (production): active when S3_BUCKET is set. Objects land at
//       replays/<tournamentId>/<matchKey>-<timestamp>.slp
//     Credentials come from the default AWS provider chain (env vars, shared
//     config, or the EC2/ECS instance role on Elastic Beanstalk — nothing is
//     passed explicitly here). S3_ENDPOINT overrides the endpoint for
//     minio/localstack-style local testing; S3_REGION (or AWS_REGION) sets
//     the region.
//
//   - Local disk (dev, default): when S3_BUCKET is unset. Files land at
//       <repo>/storage/replays/<tournamentId>/<matchKey>-<timestamp>.slp
//
// The DB persists StoredReplay.storagePath, so the two backends are
// distinguishable per row: local rows start with "storage/replays/", S3 rows
// are bare object keys starting with "replays/". readReplayFile() understands
// both, so legacy local rows keep working after S3 is switched on.
//
// __dirname is apps/api/src/lib under tsx and apps/api/dist/lib when built —
// both sit two levels below apps/api, so four levels up is the repo root.
const STORAGE_ROOT = process.env.REPLAY_STORAGE_DIR
  ? path.resolve(process.env.REPLAY_STORAGE_DIR)
  : path.resolve(__dirname, "../../../../storage/replays");

const LOCAL_PREFIX = "storage/replays/";
const S3_KEY_PREFIX = "replays";

// Keep path segments filesystem-safe (params arrive from the URL; the route
// validates them against the DB first, but never trust them as raw paths).
// Applied identically to S3 keys so the two backends stay interchangeable.
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function s3Bucket(): string | undefined {
  return process.env.S3_BUCKET || undefined;
}

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    const endpoint = process.env.S3_ENDPOINT || undefined;
    s3Client = new S3Client({
      region: process.env.S3_REGION || process.env.AWS_REGION || "us-east-1",
      ...(endpoint
        ? {
            endpoint,
            // minio/localstack serve buckets path-style; real AWS endpoints
            // keep the default virtual-hosted style.
            forcePathStyle: !/\.amazonaws\.com/i.test(endpoint),
          }
        : {}),
      // No explicit credentials: default provider chain (see header comment).
    });
  }
  return s3Client;
}

export interface StoredReplay {
  // Relative to the repo root, POSIX separators — what we persist in the DB
  // so the storage root can move (or become an S3 key prefix) later.
  // In S3 mode this is the object key (replays/<tournamentId>/<file>.slp).
  storagePath: string;
  absolutePath: string;
}

/**
 * Persist a .slp replay buffer using the configured backend.
 * @param tournamentId - the tournament the match belonged to (used as directory name).
 * @param matchKey     - the bracket match key (e.g. "W2-1"), used in the filename.
 * @param buffer       - raw .slp file contents.
 * @returns storagePath (persisted in DB) and absolutePath (for immediate use).
 *
 * The timestamp suffix in the filename ensures uniqueness for retries/re-uploads.
 * Both path components use safeSegment() to prevent path traversal.
 *
 * @throws on S3 PutObject failure or local fs.writeFile failure.
 */
export async function saveReplayFile(
  tournamentId: string,
  matchKey: string,
  buffer: Buffer
): Promise<StoredReplay> {
  const dirName = safeSegment(tournamentId);
  const fileName = `${safeSegment(matchKey)}-${Date.now()}.slp`;

  const bucket = s3Bucket();
  if (bucket) {
    const key = path.posix.join(S3_KEY_PREFIX, dirName, fileName);
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: "application/octet-stream",
      })
    );
    return {
      storagePath: key,
      absolutePath: `s3://${bucket}/${key}`,
    };
  }

  const dir = path.join(STORAGE_ROOT, dirName);
  await fs.mkdir(dir, { recursive: true });

  const absolutePath = path.join(dir, fileName);
  await fs.writeFile(absolutePath, buffer);

  return {
    storagePath: path.posix.join("storage", "replays", dirName, fileName),
    absolutePath,
  };
}

/**
 * Fetch a previously stored replay by its persisted storagePath.
 * Handles both local and S3 storage paths (determined by prefix).
 * @param storagePath - the value previously returned by saveReplayFile and
 *                      stored in the DB (e.g. "storage/replays/..." or "replays/...").
 * @returns Raw .slp file contents as a Buffer.
 *
 * @throws {Error} if the storagePath points to S3 but S3_BUCKET is not configured.
 * @throws {Error} if the S3 response body is empty.
 * @throws on fs.readFile failure for local paths.
 */
export async function readReplayFile(storagePath: string): Promise<Buffer> {
  if (storagePath.startsWith(LOCAL_PREFIX)) {
    // Local row. Resolve against STORAGE_ROOT (not the repo root) so the
    // REPLAY_STORAGE_DIR override keeps working.
    const relative = storagePath.slice(LOCAL_PREFIX.length);
    return fs.readFile(path.join(STORAGE_ROOT, relative));
  }

  const bucket = s3Bucket();
  if (!bucket) {
    throw new Error(
      `Replay ${storagePath} is stored in S3 but S3_BUCKET is not configured`
    );
  }

  const response = await getS3Client().send(
    new GetObjectCommand({ Bucket: bucket, Key: storagePath })
  );
  if (!response.Body) {
    throw new Error(`Empty S3 response body for replay ${storagePath}`);
  }
  return Buffer.from(await response.Body.transformToByteArray());
}
