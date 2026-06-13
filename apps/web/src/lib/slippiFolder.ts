/**
 * slippiFolder.ts — IndexedDB persistence for the Slippi replay folder handle.
 *
 * PURPOSE
 *   The Device page lets users pick their local Slippi replay folder via the
 *   File System Access API (Chromium-only). This module persists the resulting
 *   FileSystemDirectoryHandle in IndexedDB so it survives page navigation and
 *   browser restarts without the user having to re-select the folder each time.
 *
 *   Caveat: browser security requires re-confirming read permission on each
 *   new session. Use `getPermittedFolder()` (not `loadSlippiFolder()` directly)
 *   to get a handle that is guaranteed to have permission for the current
 *   session.
 *
 * INDEXEDDB SCHEMA
 *   Database : "foxtrot"  (version 1)
 *   Object store: "slippi_folder"
 *   Single record stored at key "handle".
 *
 * EXPORTS
 * ──────────────────────────────────────────────────────────────────────────
 *   saveSlippiFolder(handle)
 *     Writes the FileSystemDirectoryHandle to IndexedDB. Overwrites any
 *     previously saved handle.
 *
 *   loadSlippiFolder() → FileSystemDirectoryHandle | null
 *     Reads the stored handle. Returns null if none has been saved or if
 *     IndexedDB returns undefined.
 *
 *   clearSlippiFolder()
 *     Deletes the stored handle from IndexedDB (e.g. on disconnect / reset).
 *
 *   getPermittedFolder() → FileSystemDirectoryHandle | null
 *     Loads the handle then checks/requests read permission via the File
 *     System Access API. Returns the handle if "granted", otherwise null.
 *     This is the primary entry point for code that needs to read replay files.
 */

// Persist a FileSystemDirectoryHandle in IndexedDB so it survives navigation.
// The handle still requires a permission check on each session (browser security).

const DB_NAME = "foxtrot";
const STORE = "slippi_folder";
const KEY = "handle";

/** Open (or create) the IndexedDB database, creating the object store on first run. */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Persist a FileSystemDirectoryHandle so it can be restored on next load. */
export async function saveSlippiFolder(handle: FileSystemDirectoryHandle) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(handle, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Load the previously saved handle, or null if none exists. */
export async function loadSlippiFolder(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle) ?? null);
    req.onerror = () => reject(req.error);
  });
}

/** Remove the stored handle (e.g. when the user disconnects their folder). */
export async function clearSlippiFolder() {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Returns the handle with read permission confirmed, or null if unavailable. */
export async function getPermittedFolder(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await loadSlippiFolder();
  if (!handle) return null;

  const permission = await handle.queryPermission({ mode: "read" });
  if (permission === "granted") return handle;

  const requested = await handle.requestPermission({ mode: "read" });
  return requested === "granted" ? handle : null;
}
