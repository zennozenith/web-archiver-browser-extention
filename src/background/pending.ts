import browser from "webextension-polyfill";

import { ok, err } from "@common/error";
import { bgRootlog as log } from "@common/log";
import type { UrlStr, Option, Int64, Page, Vec } from "@common/types";
import { errorIfServerUnconfigured, getExtensionSettings } from "@common/settings";
import { request } from "./reqwest";
import type { TestEndpointResponse } from "./reqwest";
import { TagDto } from "./tags";
import { nowUnixEpochSeconds, UnixEpochSeconds } from "@common/time";
import { createUrl } from "@common/index";

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
  url: UrlStr;
  title: Option<string>;
  status: PendingStatus;
  attempts: Int64;
  lastError: Option<string>;
  createdAt: UnixEpochSeconds;
  /* tag names queued with this URL (server-authoritative) */
  tags: Vec<TagDto>;
}

export interface PendingInStorage {
  fetchedAt: UnixEpochSeconds;
  total: number;
  items: PendingDto[];
  error?: string;
}

/** Fetch the server's pending queue and cache the result in
 *  browser.storage.local ("pending"). */
export async function refreshPending() {
  const { serverUrl, token } = await getExtensionSettings();
  const [_, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return err(serverUnconfigured);

  const [res, resError] = await request<Page<PendingDto>>(createUrl(serverUrl, "/api/pending"), {
    token,
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
  if (res !== null) {
    data = {
      fetchedAt: nowUnixEpochSeconds(),
      total: res.items.length,
      items: res.items,
    };
  } else {
    // Keep the last good list, surface the error to the popup.
    data = {
      fetchedAt: nowUnixEpochSeconds(),
      total: previous?.total ?? 0,
      items: previous?.items ?? [],
      error: resError.detail,
    };
  }
  await browser.storage.local.set({ pending: data });

  log[res !== null ? "debug" : "warn"]("Pending refresh", { total: data.total });
  return ok(null);
}

/** Add an URL (with optional queued tags) to the server's pending queue. */
export async function addPending(
  url: UrlStr,
  { title, tags }: { title?: string; tags?: string[] } = {},
) {
  const { serverUrl, token } = await getExtensionSettings();
  const [_, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return err(serverUnconfigured);

  const res = await request<PendingDto>(createUrl(serverUrl, "/api/pending"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, title, tags }),
    token,
    timeoutMs: 20000,
  });

  if (res[0] !== null) {
    log.debug("Pending tags created", { id: res[0].id, url, tags });
  }

  return res;
}

/** GET /api/pending — used for the endpoint test. */
export async function testPending(pendingUrl: URL, token?: string) {
  const [res, error] = await request<Page<PendingDto>>(createUrl(pendingUrl, "/api/pending"), {
    token,
    timeoutMs: 20000,
  });

  if (error) {
    return {
      ok: false,
      text: `pending ✗ ${error.detail}`,
    } satisfies TestEndpointResponse;
  }
  return {
    ok: true,
    text: `pending ✓ (${res.items.length} item(s))`,
  } satisfies TestEndpointResponse;
}
