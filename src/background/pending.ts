import browser from "webextension-polyfill";

import { createError, createOk, type Result } from "@common/error";
import { bgRootlog as log } from "@common/log";
import type { Url, Option, Int64, Page, Vec } from "@common/types";
import { getEndpoint, getExtentionSettings } from "@common/settings";
import { request } from "./reqwest";
import type { TestEndpointResponse } from "./reqwest";
import { ApiTag } from "./tags";
import { nowUnixEpochSeconds, UnixEpochSeconds } from "@common/time";

/* Pending queue client.
 *
 * Tags queued with a URL live on the SERVER (`pending.tags` on both servers):
 * - POST   /api/pending      { url, title?, tags? }
 * - GET    /api/pending      -> { items: [{ id, url, title, addedAt, tags }], total }
 * - PATCH  /api/pending/:id  { tags }          replace the queued tags
 * The archive handler merges the queued tags into the site on first archive and
 * removes the pending row, so nothing needs to be kept in extension storage. */

export type PendingStatus = "queued" | "in_progress" | "failed";

export interface PendingDto {
  id: Int64;
  url: Url;
  title: Option<string>;
  status: PendingStatus;
  attempts: Int64;
  last_error: Option<string>;
  created_at: UnixEpochSeconds;
  /* tag names queued with this URL (server-authoritative) */
  tags: Vec<ApiTag>;
}

export interface PendingInStorage {
  fetched_at: UnixEpochSeconds;
  total: number;
  items: PendingDto[];
  error?: string;
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

  const res = await request<Page<PendingDto>>(endpoint.pending, {
    token: settings.apiToken,
    timeoutMs: 20000,
  });

  let previous: PendingInStorage | null = null;
  try {
    const { pending } = (await browser.storage.local.get({ pending: null })) as {
      pending: PendingInStorage | null;
    };
    previous = pending;
  } catch {}

  let data: PendingInStorage;
  if (res.ok) {
    data = {
      fetched_at: nowUnixEpochSeconds(),
      total: res.data.items.length,
      items: res.data.items,
    };
  } else {
    // Keep the last good list, surface the error to the popup.
    data = {
      fetched_at: nowUnixEpochSeconds(),
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
  { title, tags }: { title?: string; tags?: string[] } = {},
): Promise<Result<PendingDto>> {
  const settings = await getExtentionSettings();
  const endpoint = getEndpoint(settings);
  const base = endpoint.pending;

  if (!base) {
    log.debug("Pending URL not configured, cannot add");
    return createError({
      logger: log,
      message: "Pending URL is not configured. Open the extension preferences.",
    });
  }

  const res = await request<PendingDto>(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, title, tags }),
    token: settings.apiToken,
    timeoutMs: 20000,
  });
  if (!res.ok) {
    return res;
  }
  log.debug("Pending tags created", { id: res.data.id, url, tags });
  return createOk(res.data);
}

/** PATCH /api/pending/:id — replace the tags queued with a URL (server-side). */
export async function updatePendingTags(
  id: Int64,
  { title, status, tags }: { title?: string; status?: PendingStatus; tags?: string[] } = {},
): Promise<Result<PendingDto>> {
  const settings = await getExtentionSettings();
  const endpoint = getEndpoint(settings);
  const base = endpoint.pending;

  if (!base) {
    log.debug("Pending URL not configured, cannot edit");
    return createError({
      logger: log,
      message: "Pending URL is not configured. Open the extension preferences.",
    });
  }

  const res = await request<PendingDto>(`${base}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    // empty list clears the queued tags
    body: JSON.stringify({ title, status, tags }),
    token: settings.apiToken,
    timeoutMs: 20000,
  });
  if (!res.ok) {
    return res;
  }
  log.debug("Pending tags updated", { id, status, tags });
  return createOk(res.data);
}

/** GET /api/pending — used for the endpoint test. */
export async function testPending(pendingUrl: Url, token?: string) {
  const data = await request<Page<PendingDto>>(pendingUrl, {
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
    text: `pending ✓ (${data.data.items.length} item(s))`,
  } satisfies TestEndpointResponse;
}
