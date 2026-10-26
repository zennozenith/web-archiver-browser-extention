import browser from "webextension-polyfill";
import { Int } from "./types";
import { createError, createOk, Result } from "./error";
import { Logger } from "./logger";

/* ---------- helpers ---------- */
export const isHttp = (url: URL | string): boolean => {
  try {
    const parsed = typeof url === "string" ? new URL(url) : url;
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};
export const isArchivable = isHttp;

export interface CanonicalizeOptions {
  sortQuery?: boolean;
  stripTracking?: boolean;
  stripHash?: boolean;
}

const TRACKING_PARAMS = /^(utm_|fbclid|gclid|msclkid|ref)/i;

export function canonicalizeUrl(input: URL | string, options: CanonicalizeOptions = {}): string {
  const { sortQuery = true, stripTracking = false, stripHash = false } = options;

  let url: URL;
  if (typeof input === "string") {
    try {
      url = new URL(input);
    } catch {
      throw new Error(`Invalid URL: ${input}`);
    }
  } else {
    url = new URL(input.href); // Clone to avoid mutating caller's URL
  }

  // Sort query parameters alphabetically
  if (sortQuery && url.search) {
    const params = [...url.searchParams.entries()];
    params.sort(([a], [b]) => a.localeCompare(b));
    url.search = new URLSearchParams(params).toString();
  }

  // Strip common tracking parameters
  if (stripTracking) {
    for (const key of url.searchParams.keys()) {
      if (TRACKING_PARAMS.test(key)) {
        url.searchParams.delete(key);
      }
    }
  }

  // Optionally strip fragment
  if (stripHash) {
    url.hash = "";
  }

  return url.href;
}

export async function sha256(input: string | Blob | File | Response): Promise<string> {
  const buf =
    typeof input === "string" ? new TextEncoder().encode(input) : await input.arrayBuffer();
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createUrl(base: URL, pathname: string): URL {
  const url = new URL(base.toString());
  url.pathname = pathname;
  return url;
}

export async function extractTabUrl(tabId: Int, logger: Logger): Promise<Result<URL>> {
  let tab: browser.Tabs.Tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch (e) {
    return createError({
      logger,
      message: `Cannot check tab with id: ${tabId}`,
      extra: e,
    });
  }
  if (!tab.url) {
    return createError({
      logger,
      message: `Cannot extract url from tab with id: ${tabId}`,
    });
  }

  const url = URL.parse(tab.url);
  if (!url) {
    return createError({
      logger,
      message: `Extract tab url:${tab.url} from tab with id: ${tabId} is not a valid URL`,
    });
  }

  if (!isArchivable(url)) {
    return createError({
      logger,
      message: `URL not archivable: ${url.toString()}`,
      extra: {
        checkedAt: Date.now(),
      },
    });
  }

  return createOk(url);
}
