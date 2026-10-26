import browser from "webextension-polyfill";

import { createError, type Result } from "@common/error";
import { bgRootlog as log } from "@common/log";
import type { UrlStr, Option, Int64, Page, Vec } from "@common/types";
import { getExtensionSettings, isServerConfigured } from "@common/settings";
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
export async function refreshPending(): Promise<{ ok: boolean } | null> {
  const extensionSettings = await getExtensionSettings();
  if (!isServerConfigured(extensionSettings)) {
    log.debug("Server is not configured, refresh skipped");
    return null;
  }

  console.table(extensionSettings.serverUrl);
  const res = await request<Page<PendingDto>>(
    createUrl(extensionSettings.serverUrl, "/api/pending"),
    {
      token: extensionSettings.token,
      timeoutMs: 20000,
    },
  );

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
      fetchedAt: nowUnixEpochSeconds(),
      total: res.data.items.length,
      items: res.data.items,
    };
  } else {
    // Keep the last good list, surface the error to the popup.
    data = {
      fetchedAt: nowUnixEpochSeconds(),
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
  url: UrlStr,
  { title, tags }: { title?: string; tags?: string[] } = {},
): Promise<Result<PendingDto>> {
  const extensionSettings = await getExtensionSettings();
  if (!isServerConfigured(extensionSettings)) {
    log.debug("Server is not configured, cannot add pending");
    return createError({
      logger: log,
      message: "Server is not configured. Open the extension preferences.",
    });
  }

  const res = await request<PendingDto>(createUrl(extensionSettings.serverUrl, "/api/pending"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, title, tags }),
    token: extensionSettings.token,
    timeoutMs: 20000,
  });

  if (res.ok) {
    log.debug("Pending tags created", { id: res.data.id, url, tags });
  }

  return res;
}

/** GET /api/pending — used for the endpoint test. */
export async function testPending(pendingUrl: URL, token?: string) {
  const res = await request<Page<PendingDto>>(createUrl(pendingUrl, "/api/pending"), {
    token,
    timeoutMs: 20000,
  });

  if (!res.ok) {
    return {
      ok: false,
      text: `pending ✗ ${res.messages.toString()}`,
    } satisfies TestEndpointResponse;
  }
  return {
    ok: true,
    text: `pending ✓ (${res.data.items.length} item(s))`,
  } satisfies TestEndpointResponse;
}
