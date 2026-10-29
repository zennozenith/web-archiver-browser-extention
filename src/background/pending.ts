import browser from "webextension-polyfill";

import { ok, err, wrapErr } from "@common/error";
import { bgRootlog as log } from "@common/log";
import type { Option, Int64, Vec, IdLessTag } from "@common/types";
import { toPage } from "@common/types";
import { errorIfServerUnconfigured, getExtensionSettings } from "@common/settings";
import { reqwest } from "./reqwest";
import type { TestEndpointResponse } from "./reqwest";
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
  url: string;
  title: Option<string>;
  status: PendingStatus;
  attempts: Int64;
  lastError: Option<string>;
  createdAt: UnixEpochSeconds;
  /* tag names queued with this URL (server-authoritative) */
  tags: Vec<IdLessTag>;
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

/** Fetch the server's pending queue and cache the result in
 *  browser.storage.local ("pending"). */
export async function refreshPending() {
  const { serverUrl, token, pendingLimit } = await getExtensionSettings();
  const [_, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
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
    const res = toPage<PendingDto>(raw);
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

  if (resError) {
    return wrapErr(resError);
  }
  return ok(data);
}

/** Add an URL (with optional queued tags) to the server's pending queue. */
export async function addPending(
  url: string,
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

/**
 * Replace the tags queued for a pending item.
 *
 * The server accepts tag names only (`{ tags: ["name", ...] }`), and unknown
 * names are created server-side when the URL is archived.
 */
export async function updatePendingTags(id: Int64, tags: readonly IdLessTag[]) {
  const { serverUrl, token } = await getExtensionSettings();
  const [_, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return wrapErr(serverUnconfigured);

  const seen = new Set<string>();
  const clean: Vec<IdLessTag> = [];
  for (const tag of tags) {
    const name = tag.name.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    clean.push({ name, color: tag.color ?? null });
  }

  const [data, error] = await reqwest<unknown>(createUrl(serverUrl, `/api/pending/${id}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags: clean.map((t) => t.name) }),
    token,
    timeoutMs: 20000,
  });
  if (error) return wrapErr(error);

  // Prefer the server's canonical tag list when it echoes one back.
  const returned = tagsFromPendingResponse(data);
  const saved = returned.length > 0 ? returned : clean;

  // Keep the cached list in sync so reopening the popup does not show stale tags.
  try {
    const { pending } = (await browser.storage.local.get({ pending: null })) as {
      pending: PendingInStorage | null;
    };
    if (pending) {
      const items = pending.items.map((item) => (item.id === id ? { ...item, tags: saved } : item));
      await browser.storage.local.set({ pending: { ...pending, items } });
    }
  } catch (e) {
    log.warn("Cannot update cached pending tags", e);
  }

  return ok<Vec<IdLessTag>>(saved);
}

function tagsFromPendingResponse(value: unknown): Vec<IdLessTag> {
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const item =
    typeof record["item"] === "object" && record["item"] !== null
      ? (record["item"] as Record<string, unknown>)
      : record;
  const raw = item["tags"];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((tag) => {
      if (typeof tag === "string") return { name: tag, color: null };
      if (typeof tag === "object" && tag !== null && "name" in tag) {
        const t = tag as { name: unknown; color?: unknown };
        return {
          name: String(t.name),
          color: typeof t.color === "string" ? t.color : null,
        };
      }
      return null;
    })
    .filter((tag): tag is IdLessTag => tag !== null && tag.name.length > 0);
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
  const res = toPage<PendingDto>(raw);
  return {
    ok: true,
    text: `pending ✓ (${res.items.length} item(s))`,
  } satisfies TestEndpointResponse;
}
