import browser from "webextension-polyfill";

import { createError, createOk, type Result } from "@common/error";
import { bgRootlog as log } from "@common/log";
import type { Url } from "@common/types";
import { getEndpoint, getExtentionSettings } from "@common/settings";
import { request } from "./reqwest";
import type { TestEndpointResponse } from "./reqwest";

/* Pending queue client.
 *
 * Tags queued with a URL live on the SERVER (`pending.tags` on both servers):
 * - POST   /api/pending      { url, title?, tags? }
 * - GET    /api/pending      -> { items: [{ id, url, title, addedAt, tags }], total }
 * - PATCH  /api/pending/:id  { tags }          replace the queued tags
 * The archive handler merges the queued tags into the site on first archive and
 * removes the pending row, so nothing needs to be kept in extension storage. */

export interface PendingItem {
  id: string;
  url: Url;
  title: string;
  addedAt: string;
  /* tag names queued with this URL (server-authoritative) */
  tags?: string[];
}

export interface PendingResponseInStorage {
  fetchedAt: number;
  total: number;
  items: PendingItem[];
  error?: string;
}

interface ApiPendingListResponse {
  items: PendingItem[];
  total: number;
}

async function pendingEndpoint(): Promise<string | null> {
  const settings = await getExtentionSettings();
  const endpoint = getEndpoint(settings);
  return endpoint.pending ? endpoint.pending.split("?")[0].replace(/\/$/, "") : null;
}

/** Fetch the server's pending queue and cache the result in
 *  browser.storage.local ("pending"). */
export async function refreshPending(): Promise<{ ok: boolean } | null> {
  const settings = await getExtentionSettings();
  const endpoint = getEndpoint(settings);
  if (!endpoint.pending) {
    log.debug("Pending URL not configured, refresh skipped");
    return null;
  }

  const res = await request<ApiPendingListResponse>(endpoint.pending, {
    token: settings.apiToken,
    timeoutMs: 20000,
  });

  let previous: PendingResponseInStorage | null = null;
  try {
    const { pending } = (await browser.storage.local.get({ pending: null })) as {
      pending: PendingResponseInStorage | null;
    };
    previous = pending;
  } catch {}

  let data: PendingResponseInStorage;
  if (res.ok) {
    data = {
      fetchedAt: Date.now(),
      total: res.data.total,
      items: res.data.items,
    };
  } else {
    // Keep the last good list, surface the error to the popup.
    data = {
      fetchedAt: Date.now(),
      total: previous?.total ?? 0,
      items: previous?.items ?? [],
      error: res.messages.toString(),
    };
  }
  await browser.storage.local.set({ pending: data });

  log[res.ok ? "debug" : "warn"]("Pending refresh", { ok: res.ok, total: data.total });
  return { ok: res.ok };
}

/** Add an URL (with optional queued tags) to the server's pending queue. */
export async function addPending(
  url: Url,
  { title = "", tags = [] }: { title?: string; tags?: string[] } = {},
): Promise<Result<PendingItem>> {
  const base = await pendingEndpoint();
  if (!base) {
    log.debug("Pending URL not configured, cannot add");
    return createError({
      logger: log,
      message: "Pending URL is not configured. Open the extension preferences.",
    });
  }

  const settings = await getExtentionSettings();
  const res = await request<{ success: true; item: PendingItem }>(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, title: title.trim(), tags }),
    token: settings.apiToken,
    timeoutMs: 20000,
  });
  if (!res.ok) {
    return res;
  }
  return createOk({ ...res.data.item, tags: res.data.item.tags ?? tags });
}

/** PATCH /api/pending/:id — replace the tags queued with a URL (server-side). */
export async function updatePendingTags(id: string, tags: string[]): Promise<Result<PendingItem>> {
  const base = await pendingEndpoint();
  if (!base) {
    log.debug("Pending URL not configured, cannot edit");
    return createError({
      logger: log,
      message: "Pending URL is not configured. Open the extension preferences.",
    });
  }

  const settings = await getExtentionSettings();
  const res = await request<{ success: true; item: PendingItem }>(`${base}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    // empty list clears the queued tags
    body: JSON.stringify({ tags }),
    token: settings.apiToken,
    timeoutMs: 20000,
  });
  if (!res.ok) {
    return res;
  }
  log.debug("Pending tags updated", { id, tags });
  return createOk(res.data.item);
}

/** GET /api/pending — used for the endpoint test. */
export async function testPending(pendingUrl: Url, token?: string) {
  const data = await request<ApiPendingListResponse>(pendingUrl, {
    token,
    timeoutMs: 20000,
  });
  if (!data.ok) {
    return {
      ok: false,
      text: `pending ✗ ${data.messages.toString()}`,
    } satisfies TestEndpointResponse;
  }
  return {
    ok: true,
    text: `pending ✓ (${data.data.total} item(s))`,
  } satisfies TestEndpointResponse;
}
