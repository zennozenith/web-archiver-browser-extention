import browser from "webextension-polyfill";
import { log as rootLog } from "./log.ts";

const log = rootLog.child("storage").child("session");

/* ---------- session storage with in-memory fallback ---------- */
const _mem_session = new Map<string, unknown>();
const _mem_sync = new Map<string, unknown>();
const _mem_local = new Map<string, unknown>();

export async function session_storage_get<T>(key: string): Promise<T> {
  if (browser.storage.session) return (await browser.storage.session.get(key))[key] as T;
  return _mem_session.get(key) as T;
}

export async function session_storage_set(key: string, val: unknown) {
  log.debug(`Setting session key: ${key}`);
  if (browser.storage.session) await browser.storage.session.set({ [key]: val });
  else _mem_session.set(key, val);
}

export async function session_storage_delete(...keys: string[]) {
  log.debug("Deleting session keys", keys);
  if (browser.storage.session) await browser.storage.session.remove(keys);
  else keys.forEach((k) => _mem_session.delete(k));
}

export async function sync_storage_get<T>(key: string): Promise<T> {
  if (browser.storage.sync) return (await browser.storage.sync.get(key))[key] as T;
  return _mem_sync.get(key) as T;
}

export async function sync_storage_set(key: string, val: unknown) {
  log.debug(`Setting sync key: ${key}`);
  if (browser.storage.sync) await browser.storage.sync.set({ [key]: val });
  else _mem_sync.set(key, val);
}

export async function sync_storage_delete(...keys: string[]) {
  log.debug("Deleting sync keys", keys);
  if (browser.storage.sync) await browser.storage.sync.remove(keys);
  else keys.forEach((k) => _mem_sync.delete(k));
}

export async function local_storage_get<T>(key: string): Promise<T> {
  if (browser.storage.local) return (await browser.storage.local.get(key))[key] as T;
  return _mem_local.get(key) as T;
}

export async function local_storage_set(key: string, val: unknown) {
  log.debug(`Setting local key: ${key}`);
  if (browser.storage.local) await browser.storage.local.set({ [key]: val });
  else _mem_local.set(key, val);
}

export async function local_storage_delete(...keys: string[]) {
  log.debug("Deleting local keys", keys);
  if (browser.storage.local) await browser.storage.local.remove(keys);
  else keys.forEach((k) => _mem_local.delete(k));
}

// /**
//  * Get current counter value from browser.storage.local
//  */
// export async function getCounter(): Promise<number> {
//   const result = await browser.storage.local.get(STORAGE_KEYS.COUNTER);
//   const val = result[STORAGE_KEYS.COUNTER];
//   return typeof val === "number" ? val : 0;
// }

// /**
//  * Update counter value in browser.storage.local
//  */
// export async function setCounter(val: number): Promise<void> {
//   await browser.storage.local.set({ [STORAGE_KEYS.COUNTER]: val });
// }
