/// <reference types="vite/client" />

// Minimal File System Access API surface used by the replay-folder feature
// (Chromium-only API; not in the standard DOM lib)
interface FileSystemDirectoryHandle {
  queryPermission(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}
