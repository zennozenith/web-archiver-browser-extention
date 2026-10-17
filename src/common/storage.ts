import browser from "webextension-polyfill";
import { DEFAULT_SETTINGS, STORAGE_KEYS } from "./constants.ts";
import { ExtensionSettings } from "./types.ts";

/* ---------- session storage with in-memory fallback ---------- */
const _mem = new Map<string, unknown>();

/**
 * Retrieve user settings from browser.storage.sync
 */
export async function getExtentionSettings(): Promise<ExtensionSettings> {
  if (!browser.storage.session) {
    return (_mem.get(STORAGE_KEYS.SETTINGS) as ExtensionSettings) ?? { ...DEFAULT_SETTINGS };
  }

  const result = await browser.storage.sync.get(STORAGE_KEYS.SETTINGS);
  const stored = (result[STORAGE_KEYS.SETTINGS] as Partial<ExtensionSettings>) ?? {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

/**
 * Save user settings to browser.storage.sync
 */
export async function saveSettings(
  settings: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const current = await getExtentionSettings();
  const updated: ExtensionSettings = { ...current, ...settings };
  await browser.storage.sync.set({ [STORAGE_KEYS.SETTINGS]: updated });
  return updated;
}

export async function session_storage_get<T>(key: string) {
  if (browser.storage.session) return (await browser.storage.session.get(key))[key] as T;
  return _mem.get(key) as T;
}

export async function session_storage_set(key: string, val: unknown) {
  if (browser.storage.session) await browser.storage.session.set({ [key]: val });
  else _mem.set(key, val);
}

export async function session_storage_delete(...keys: string[]) {
  if (browser.storage.session) await browser.storage.session.remove(keys);
  else keys.forEach((k) => _mem.delete(k));
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
