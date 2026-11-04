import browser from "webextension-polyfill";

import { ok, err, wrapErr } from "@common/error";
import { bgRootlog as log } from "@common/log";
import type {
  CreatePendingRequest,
  PatchPendingRequest,
  PendingItem,
  PendingStatus,
} from "@common/api-types";
import type { IdLessTag, Int64, Vec } from "@common/types";
import { toPage } from "@common/types";
import { errorIfServerUnconfigured, getExtensionSettings } from "@common/settings";
import { reqwest } from "./reqwest";
import type { TestEndpointResponse } from "./reqwest";
import { nowUnixEpochSeconds, UnixEpochSeconds } from "@common/time";
import { createUrl } from "@common/index";

/* Pending queue client.
 *
 * Tags queued with a URL live on the SERVER:
 * - POST   /api/pending      { url, tags? }
 * - GET    /api/pending      -> { items: [...], nextCursor }
 * - PATCH  /api/pending/:id  { tags }          replace the queued tags
 * The archive handler attaches the queued tags on first archive and removes the
 * pending row, so nothing needs to be kept in extension storage. */

export type { PendingStatus };

export interface PendingInStorage {
  fetchedAt: UnixEpochSeconds;
  total: number;
  hasMore: boolean; // server has more items than were returned
  items: PendingItem[];
  error?: string;
}

export type GetPendingFromStorage = Awaited<ReturnType<typeof getPendingFromStorage>>;
export type RefreshPending = Awaited<ReturnType<typeof refreshPending>>;
export type SetPendingTags = Awaited<ReturnType<typeof updatePendingTags>>;

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

/** Fetch the server's pending queue and cache the result in storage.local. */
export async function refreshPending() {
  const { serverUrl, token, pendingLimit } = await getExtensionSettings();
  const [, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return wrapErr(serverUnconfigured);

  const reqUrl = createUrl(serverUrl, "/api/pending");
  reqUrl.searchParams.set("limit", String(Math.max(1, Number(pendingLimit) || 200)));

  const [raw, resError] = await reqwest<unknown>(reqUrl, {
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
  if (raw !== null) {
    const res = toPage<PendingItem>(raw);
    const total = res.total ?? res.items.length;
    data = {
      fetchedAt: nowUnixEpochSeconds(),
      total,
      hasMore: res.nextCursor !== null || total > res.items.length,
      items: res.items,
      error: undefined,
    };
  } else {
    data = {
      fetchedAt: nowUnixEpochSeconds(),
      total: previous?.total ?? 0,
      hasMore: previous?.hasMore ?? false,
      items: previous?.items ?? [],
      error: resError?.detail,
    };
  }
  await browser.storage.local.set({ pending: data });
  log[raw !== null ? "debug" : "warn"]("Pending refresh", { total: data.total });

  if (resError) return wrapErr(resError);
  return ok(data);
}

/** Add a URL (with optional queued tags) to the server's pending queue. */
export async function addPending(url: string, { tags }: { tags?: string[] } = {}) {
  const { serverUrl, token } = await getExtensionSettings();
  const [, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return wrapErr(serverUnconfigured);

  const body: CreatePendingRequest = { url, tags };
  const res = await reqwest<PendingItem>(createUrl(serverUrl, "/api/pending"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    token,
    timeoutMs: 20000,
  });

  if (res[0] !== null) {
    log.debug("Pending item created", { id: res[0].id, url, tags });
  }
  return res;
}

/**
 * Replace the tags queued for a pending item.
 *
 * The server accepts tag names only; unknown names are created when the URL is
 * archived.
 */
export async function updatePendingTags(id: Int64, tags: readonly IdLessTag[]) {
  const { serverUrl, token } = await getExtensionSettings();
  const [, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return wrapErr(serverUnconfigured);

  const seen = new Set<string>();
  const clean: Vec<IdLessTag> = [];
  for (const tag of tags) {
    const name = tag.name.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    clean.push({ name, color: tag.color ?? null });
  }

  const body: PatchPendingRequest = { tags: clean.map((tag) => tag.name) };
  const [pending, error] = await reqwest<PendingItem>(createUrl(serverUrl, `/api/pending/${id}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    token,
    timeoutMs: 20000,
  });
  if (error) return wrapErr(error);

  // Keep the cached list in sync so reopening the popup does not show stale tags.
  try {
    const { pending: cached } = (await browser.storage.local.get({ pending: null })) as {
      pending: PendingInStorage | null;
    };
    if (cached) {
      const items = cached.items.map((item) =>
        item.id === id ? { ...item, tags: pending.tags ?? [] } : item,
      );
      await browser.storage.local.set({ pending: { ...cached, items } });
    }
  } catch (e) {
    log.warn("Cannot update cached pending tags", e);
  }

  return ok(pending.tags ?? []);
}

/** GET /api/pending — used for the endpoint test. */
export async function testPending(serverUrl: URL, token?: string) {
  const [raw, error] = await reqwest<unknown>(createUrl(serverUrl, "/api/pending"), {
    token,
    timeoutMs: 20000,
  });

  if (error) {
    return {
      ok: false,
      text: `pending ✗ ${error.detail}`,
    } satisfies TestEndpointResponse;
  }
  const res = toPage<PendingItem>(raw);
  return {
    ok: true,
    text: `pending ✓ (${res.items.length} item(s))`,
  } satisfies TestEndpointResponse;
}
