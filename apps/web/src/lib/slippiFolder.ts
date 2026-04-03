// Persist a FileSystemDirectoryHandle in IndexedDB so it survives navigation.
// The handle still requires a permission check on each session (browser security).

const DB_NAME = "foxtrot";
const STORE = "slippi_folder";
const KEY = "handle";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSlippiFolder(handle: FileSystemDirectoryHandle) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(handle, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadSlippiFolder(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle) ?? null);
    req.onerror = () => reject(req.error);
  });
}

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
