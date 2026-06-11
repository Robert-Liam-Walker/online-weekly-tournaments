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

// Fetch a previously stored replay by its persisted storagePath (either
// backend). Not used by the upload route yet — this is the read half of the
// storage seam for the replay-download endpoint.
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
