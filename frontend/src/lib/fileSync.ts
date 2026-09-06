/**
 * Optional File System Access integration. Lets the user connect a single
 * backup file on disk and then re-save to it with one click — or automatically
 * on every change. If they put that file inside a synced folder (Google Drive,
 * Dropbox, iCloud Drive, OneDrive desktop app), their own machine syncs it to
 * the cloud; the app itself still never uploads anything.
 *
 * Desktop-Chromium only (Chrome/Edge/Opera/Brave/Arc). Everywhere else this is
 * simply unavailable and the manual Download/Restore flow remains the fallback.
 */
import { api, onDataChange } from "../api";

// --- minimal typings (these APIs aren't in the standard TS DOM lib) --------- //
type PermState = "granted" | "denied" | "prompt";
interface FSWritable { write(data: string): Promise<void>; close(): Promise<void> }
interface FSFileHandle {
  name: string;
  createWritable(): Promise<FSWritable>;
  getFile(): Promise<File>;
  queryPermission(d: { mode: "read" | "readwrite" }): Promise<PermState>;
  requestPermission(d: { mode: "read" | "readwrite" }): Promise<PermState>;
}
interface PickerWindow {
  showSaveFilePicker?(opts?: unknown): Promise<FSFileHandle>;
  showOpenFilePicker?(opts?: unknown): Promise<FSFileHandle[]>;
}
const w = window as unknown as PickerWindow;

export function isSupported(): boolean {
  return typeof w.showSaveFilePicker === "function" && typeof w.showOpenFilePicker === "function";
}

const PICKER_TYPES = [{ description: "RetirementBuddy backup", accept: { "application/json": [".json"] } }];
const SUGGESTED = "retirementbuddy-backup.json";

// --- tiny IndexedDB store for the handle (kept OUT of the exported data) ----- //
interface SyncState { handle: FSFileHandle; autoSave: boolean; lastSaved: number | null }
const DB = "retirementbuddy-fs";
const STORE = "kv";
const KEY = "state";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function readState(): Promise<SyncState | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as SyncState) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}
async function writeState(s: SyncState | null): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    if (s) tx.objectStore(STORE).put(s, KEY); else tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let cache: SyncState | null = null;
let loaded = false;
async function state(): Promise<SyncState | null> {
  if (!loaded) { cache = await readState(); loaded = true; }
  return cache;
}
async function setState(s: SyncState | null): Promise<void> { cache = s; loaded = true; await writeState(s); }

// --- public surface --------------------------------------------------------- //

export interface SyncStatus {
  connected: boolean;
  name: string | null;
  permission: PermState;   // readwrite permission on the stored handle
  autoSave: boolean;
  lastSaved: number | null;
}

export async function getStatus(): Promise<SyncStatus> {
  const s = await state();
  if (!s) return { connected: false, name: null, permission: "prompt", autoSave: false, lastSaved: null };
  let permission: PermState = "prompt";
  try { permission = await s.handle.queryPermission({ mode: "readwrite" }); } catch { /* ignore */ }
  return { connected: true, name: s.handle.name, permission, autoSave: s.autoSave, lastSaved: s.lastSaved };
}

async function writeHandle(handle: FSFileHandle): Promise<void> {
  const json = await api.exportBackup();
  const writable = await handle.createWritable();
  await writable.write(json);
  await writable.close();
}

/** Pick/create a backup file, write current data, and remember it (gesture). */
export async function connect(): Promise<SyncStatus> {
  if (!w.showSaveFilePicker) throw new Error("Not supported in this browser.");
  const handle = await w.showSaveFilePicker({ suggestedName: SUGGESTED, types: PICKER_TYPES });
  await writeHandle(handle);
  await setState({ handle, autoSave: true, lastSaved: Date.now() });
  return getStatus();
}

/** Re-grant readwrite permission to the stored handle (gesture) after a reload. */
export async function reconnect(): Promise<SyncStatus> {
  const s = await state();
  if (!s) throw new Error("No backup file connected.");
  const perm = await s.handle.requestPermission({ mode: "readwrite" });
  if (perm !== "granted") throw new Error("Permission to the file was not granted.");
  return getStatus();
}

/** Write current data to the connected file now (gesture; will prompt if needed). */
export async function saveNow(): Promise<SyncStatus> {
  const s = await state();
  if (!s) throw new Error("No backup file connected.");
  if ((await s.handle.queryPermission({ mode: "readwrite" })) !== "granted") {
    if ((await s.handle.requestPermission({ mode: "readwrite" })) !== "granted") {
      throw new Error("Permission to the file was not granted.");
    }
  }
  await writeHandle(s.handle);
  await setState({ ...s, lastSaved: Date.now() });
  return getStatus();
}

/** Pick a file to restore from (gesture) and return its JSON text for the
 *  caller to hand to api.importBackup(). Does NOT adopt it as the auto-save
 *  target — connecting a sync file is a separate, deliberate action, so a
 *  cancelled restore can never later overwrite the chosen file. */
export async function openFrom(): Promise<string> {
  if (!w.showOpenFilePicker) throw new Error("Not supported in this browser.");
  const [handle] = await w.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
  return (await handle.getFile()).text();
}

export async function setAutoSave(on: boolean): Promise<void> {
  const s = await state();
  if (s) await setState({ ...s, autoSave: on });
}

export async function disconnect(): Promise<void> { await setState(null); }

/** Auto-save watcher: on any data change, silently write if enabled and allowed
 *  (never prompts — a silent write only proceeds when permission is granted). */
let started = false;
export function startAutoSaveWatcher(): void {
  if (started) return;
  started = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDataChange(() => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const s = await state();
      if (!s || !s.autoSave) return;
      try {
        if ((await s.handle.queryPermission({ mode: "readwrite" })) !== "granted") return;
        await writeHandle(s.handle);
        await setState({ ...s, lastSaved: Date.now() });
      } catch { /* file moved/removed or permission lost — leave the manual flow */ }
    }, 900);
  });
}
