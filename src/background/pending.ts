import browser from "webextension-polyfill";

import { ok, err, wrapErr } from "@common/error";
import { bgRootlog as log } from "@common/log";
import type { UrlStr, Option, Int64, Page, Vec } from "@common/types";
import { errorIfServerUnconfigured, getExtensionSettings } from "@common/settings";
import { reqwest } from "./reqwest";
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
  hasMore: boolean; //  server has more items than were returned
  items: PendingDto[];
  error?: string;
}

export type GetPendingFromStorage = Awaited<ReturnType<typeof getPendingFromStorage>>;
export type RefreshPending = Awaited<ReturnType<typeof refreshPending>>;

export async function getPendingFromStorage() {
  const { pending } = (await browser.storage.local.get({ pending: null })) as {
    pending: PendingInStorage | null;
  };

  if (pending === null) {
    return err({
      logger: log,
      reason: "pending_not_fetched",
      detail: "Pending list has not been fetched yet",
    });
  }
  return ok<PendingInStorage>(pending);
}

/** Fetch the server's pending queue and cache the result in
 *  browser.storage.local ("pending"). */
export async function refreshPending() {
  const { serverUrl, token } = await getExtensionSettings();
  const [_, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return wrapErr(serverUnconfigured);

  const [res, resError] = await reqwest<Page<PendingDto>>(createUrl(serverUrl, "/api/pending"), {
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
      hasMore: res.nextCursor !== null,
      items: res.items,
      error: undefined,
    };
  } else {
    data = {
      fetchedAt: nowUnixEpochSeconds(),
      total: previous?.total ?? 0,
      hasMore: previous?.hasMore ?? false,
      items: previous?.items ?? [],
      error: resError.detail,
    };
  }
  await browser.storage.local.set({ pending: data });
  log[res !== null ? "debug" : "warn"]("Pending refresh", { total: data.total });

  if (resError) {
    return wrapErr(resError);
  }
  return ok(data);
}

/** Add an URL (with optional queued tags) to the server's pending queue. */
export async function addPending(
  url: UrlStr,
  { title, tags }: { title?: string; tags?: string[] } = {},
) {
  const { serverUrl, token } = await getExtensionSettings();
  const [_, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return wrapErr(serverUnconfigured);

  const res = await reqwest<PendingDto>(createUrl(serverUrl, "/api/pending"), {
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
  const [res, error] = await reqwest<Page<PendingDto>>(createUrl(pendingUrl, "/api/pending"), {
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
