import { toDate } from "./time.ts";
import {
  CheckUrlResponse,
  DerivedEndpoint,
  ErrorWithMessage,
  ExtensionSettings,
  Pending,
  ReqeustOptions,
  Url,
} from "./types.ts";

export * from "./types.ts";
export * from "./constants.ts";
export * from "./time.ts";
export * from "./storage.ts";
export * from "./messaging.ts";

export function $<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const element = document.getElementById(id);
  if (element instanceof type) {
    return element;
  } else {
    // throw new Error(`Element with id: ${id}, of type: ${type}`);
    console.warn(`Element with id: ${id}, of type: ${type}`);
  }
  return element as T;
  // return element instanceof type ? element : null;
}

export function setElementText(el: Element, text: string, cls: string = ""): void {
  el.textContent = text;
  el.className = cls || "";
}

export function deriveEndpoints(settings: ExtensionSettings): DerivedEndpoint {
  const baseUrl = (settings.serverUrl ?? "").trim().replace(/\/+\$/, "");

  const derivedUrls = baseUrl
    ? {
        archive: `${baseUrl}/api/archive`,
        pending: `${baseUrl}/api/pending`,
        check: `${baseUrl}/api/check`,
      }
    : { archive: "", pending: "", check: "" };

  const endpointKeys = ["archive", "pending", "check"] as const;

  // Build the resolved endpoints and their sources dynamically
  const resolvedEndpoints = {} as Record<(typeof endpointKeys)[number], string>;
  const endpointSources = {} as Record<
    (typeof endpointKeys)[number],
    "none" | "derived" | "override"
  >;

  for (const key of endpointKeys) {
    const customUrl = String(settings[`${key}Url`] ?? "").trim();

    resolvedEndpoints[key] = customUrl || derivedUrls[key];

    endpointSources[key] = customUrl ? "override" : derivedUrls[key] ? "derived" : "none";
  }

  return {
    derived: derivedUrls,
    source: endpointSources,
    ...resolvedEndpoints,
  };
}

/* ---------- helpers ---------- */
export const isHttp = (u?: Url) => /^https?:\/\//i.test(u || "");
export const isArchivable = isHttp;

export function normalizeUrl(url: string): string {
  try {
    const parsedUrl = new URL(url.trim());
    parsedUrl.hash = "";
    return parsedUrl.toString();
  } catch {
    return url;
  }
}

export function buildCheckUrl(checkUrl: Url, pageUrl: Url) {
  if (checkUrl.includes("{url}")) return checkUrl.replace("{url}", encodeURIComponent(pageUrl));
  const url = new URL(checkUrl);
  url.searchParams.set("url", pageUrl);
  return url.toString();
}

/* ---------- HTTP ---------- */
export async function request<T>(
  url: Url,
  {
    method = "GET",
    body,
    headers: orignalHeaders = {},
    token,
    timeoutMs = 30000,
  }: ReqeustOptions = {},
): Promise<string | NonNullable<T>> {
  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }

  const headers: Record<string, string> = { Accept: "application/json", ...orignalHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res, text;
  try {
    res = await fetch(url, {
      method,
      body,
      headers: headers,
      signal: ctrl.signal,
      cache: "no-store",
      credentials: "omit",
    });
    text = await res.text();
  } catch (e) {
    throw new Error(
      (e as { name: string }).name === "AbortError"
        ? `Request timed out after ${Math.round(timeoutMs / 1000)}s (${url})`
        : `Cannot reach server at ${url}: ${(e as ErrorWithMessage).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
  let data: T | null = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }

  if (!res.ok) {
    let error_data = data as null | { error?: string; message?: string; detail?: string };
    const m = error_data && (error_data.error || error_data.message || error_data.detail);
    const msg = m
      ? typeof m === "string"
        ? m
        : JSON.stringify(m)
      : (text || res.statusText).slice(0, 300);
    throw new Error(`Server error ${res.status}: ${msg}`);
  }
  return data ?? text;
}

/**
 * Tolerant parsers: accept several common response shapes.
 */
export function normalizeCheck(data: Record<string, unknown>): CheckUrlResponse {
  if (!data || typeof data !== "object") return { archived: false, count: 0, versions: [] };

  let list = (data.versions || data.snapshots || data.archives || data.items || []) as Array<any>;

  if (!Array.isArray(list)) list = [];

  let versions = list.map((v: any) =>
    typeof v === "object" && v
      ? {
          id: v.id ?? v.version ?? null,
          time:
            v.archivedAt ??
            v.archived_at ??
            v.created_at ??
            v.createdAt ??
            v.timestamp ??
            v.time ??
            v.date ??
            null,
          url: v.url ?? v.link ?? null,
        }
      : { id: null, time: v, url: null },
  );
  versions.sort((a, b) => ((toDate(b.time) || 0) as any) - ((toDate(a.time) || 0) as any));

  const count =
    Number(
      data.count ??
        data.versionCount ??
        data.version_count ??
        data.versions_count ??
        versions.length,
    ) || 0;
  const archived = Boolean(data.archived ?? data.exists ?? data.found ?? count > 0);
  const last = (data.lastArchivedAt ??
    data.last_archived_at ??
    data.latest ??
    versions[0]?.time ??
    null) as string | null;
  return { archived, count, versions, last };
}

/**
 * Tolerant parsers: accept several common response shapes and returns Pending
 */
export function normalizePending(data: Record<string, unknown>): Pending {
  let arr = Array.isArray(data)
    ? data
    : (((data && (data.urls || data.items || data.pending || data.results || data.data)) ||
        []) as Array<any>);
  if (!Array.isArray(arr)) arr = [];

  return {
    items: arr
      .map((x: any) =>
        typeof x === "string"
          ? { url: x }
          : {
              url: x.url || x.href || x.link,
              title: x.title || x.name || "",
              addedAt: x.addedAt ?? x.added_at ?? x.created_at ?? x.createdAt ?? null,
            },
      )
      .filter((x) => isHttp(x.url)) as Pending["items"],
    error: data.error,
    fetchedAt: data.error,
    total: data.error,
  } as Pending;
}

export async function sha256(input: string | Blob | File | Response): Promise<string> {
  const buf =
    typeof input === "string" ? new TextEncoder().encode(input) : await input.arrayBuffer();
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
