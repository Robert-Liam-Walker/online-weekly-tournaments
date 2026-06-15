import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

// Candidate/stable release channels for the launcher manifest, backed by S3.
//
// Layout (under the bucket, "manifests/" prefix):
//   manifests/releases/<id>.json      immutable per-release snapshot — the exact
//                                      v1 manifest body the launcher expects
//                                      (dolphin/gameFiles/launcher + sha256s).
//                                      Never overwritten.
//   manifests/channels/stable.json    { "release": "<id>" }  pointer
//   manifests/channels/candidate.json
//
// Promotion/rollback = repoint a channel (one PutObject), never a rebuild. When
// no bucket is configured the store is "absent" and callers fall back to the
// legacy env-var manifest, so dev and current prod keep working unchanged.
//
// S3 conventions mirror replayStorage.ts: default AWS provider chain (the EB
// instance role — nothing passed explicitly) and S3_ENDPOINT for
// minio/localstack. The bucket is its OWN dedicated env var (RELEASE_S3_BUCKET,
// not a fallback to S3_BUCKET) so the manifest store is decoupled from the
// replays bucket and stays OFF until explicitly configured — deploying this
// code changes nothing about the served manifest until we opt in.

export type Channel = "stable" | "candidate";

interface DolphinBuild {
  version: string;
  win32: string;
  darwin?: string;
  linux?: string;
  /** Recorded for all artifacts; the current launcher only ENFORCES gameFiles.sha256. */
  sha256?: string;
}

/** The exact v1 manifest body the launcher parses (see routes/launcher.ts). */
export interface ReleaseManifest {
  manifestVersion: number;
  dolphin: { netplay: DolphinBuild | null; playback: DolphinBuild | null } | null;
  gameFiles: { version: string; url: string; sha256: string } | null;
  launcher: { minimumVersion: string } | null;
}

const PREFIX = "manifests";
const releaseKey = (id: string) => `${PREFIX}/releases/${id}.json`;
const channelKey = (c: Channel) => `${PREFIX}/channels/${c}.json`;

export function releaseBucket(): string | undefined {
  return process.env.RELEASE_S3_BUCKET || undefined;
}

/** True when an S3 release store is configured; otherwise callers fall back. */
export function releaseStoreConfigured(): boolean {
  return !!releaseBucket();
}

let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) {
    const endpoint = process.env.S3_ENDPOINT || undefined;
    client = new S3Client({
      region: process.env.S3_REGION || process.env.AWS_REGION || "us-east-1",
      ...(endpoint
        ? { endpoint, forcePathStyle: !/\.amazonaws\.com/i.test(endpoint) }
        : {}),
    });
  }
  return client;
}

async function getJson<T>(key: string): Promise<T | null> {
  const bucket = releaseBucket();
  if (!bucket) return null;
  try {
    const res = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!res.Body) return null;
    return JSON.parse(await res.Body.transformToString()) as T;
  } catch (err) {
    // A missing key is a normal "nothing published yet" — return null so the
    // caller falls back to the env-var manifest. Anything else is real.
    const name = (err as { name?: string })?.name;
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw err;
  }
}

async function putJson(key: string, value: unknown): Promise<void> {
  const bucket = releaseBucket();
  if (!bucket) {
    throw new Error("No release bucket configured (set RELEASE_S3_BUCKET or S3_BUCKET)");
  }
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(value, null, 2),
      ContentType: "application/json",
    })
  );
}

/** Resolve a channel → its current release manifest (null if unset or store absent). */
export async function getChannelManifest(channel: Channel): Promise<ReleaseManifest | null> {
  const ptr = await getJson<{ release?: string }>(channelKey(channel));
  if (!ptr?.release) return null;
  return getJson<ReleaseManifest>(releaseKey(ptr.release));
}

/** The release id a channel currently points at (null if unset). */
export async function getChannelRelease(channel: Channel): Promise<string | null> {
  const ptr = await getJson<{ release?: string }>(channelKey(channel));
  return ptr?.release ?? null;
}

/** Write an immutable release snapshot. Refuses to overwrite an existing id. */
export async function publishRelease(id: string, manifest: ReleaseManifest): Promise<void> {
  const existing = await getJson<ReleaseManifest>(releaseKey(id));
  if (existing) {
    throw new Error(`Release "${id}" already exists — bump the version (snapshots are immutable)`);
  }
  await putJson(releaseKey(id), manifest);
}

/** Point a channel at an existing release id (promotion / rollback). */
export async function setChannel(channel: Channel, releaseId: string): Promise<void> {
  const snapshot = await getJson<ReleaseManifest>(releaseKey(releaseId));
  if (!snapshot) {
    throw new Error(`Release "${releaseId}" not found — publish it before pointing a channel at it`);
  }
  await putJson(channelKey(channel), { release: releaseId });
}
