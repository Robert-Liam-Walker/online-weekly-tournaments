/// <reference types="vite/client" />

/**
 * Vite environment variable declarations for the FoxTrot web app.
 *
 * All variables are prefixed with VITE_ so Vite exposes them to client-side
 * code via import.meta.env. Variables without this prefix are server-only
 * and will be undefined in the browser bundle.
 *
 * VITE_API_URL (optional)
 *   Base URL of the FoxTrot REST API, without a trailing slash.
 *   Unset in local dev and production same-origin deploys — the axios
 *   instance in lib/api.ts falls back to "/api" (proxied by Vite in dev,
 *   path-routed by the ALB in prod).
 *   Set in staging when the SPA (S3) and API (Elastic Beanstalk) are on
 *   different origins, e.g. "https://api.staging.foxtrot.gg".
 *
 * VITE_SOCKET_URL (optional)
 *   WebSocket server URL for Socket.io.
 *   Unset in local dev and production — lib/socket.ts falls back to
 *   window.location.origin (same host, proxied by Vite / ALB).
 *   Set in staging when the socket server differs from the SPA origin.
 */
interface ImportMetaEnv {
  /** REST API base URL; falls back to same-origin "/api" when unset. */
  readonly VITE_API_URL?: string;
  /** Socket.io server URL; falls back to window.location.origin when unset. */
  readonly VITE_SOCKET_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Minimal File System Access API surface used by the replay-folder feature
 * (Chromium-only API; not in the standard DOM lib).
 *
 * Extended from the built-in FileSystemHandle to add the permission methods
 * and the entries() async iterator needed by slippiFolder.ts.
 */
interface FileSystemDirectoryHandle {
  queryPermission(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}
