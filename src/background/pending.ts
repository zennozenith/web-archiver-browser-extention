import browser from "webextension-polyfill";

import { createError, isStandardError, Result } from "@common/error";
import { bgRootlog } from "@common/log";
import { getEndpoint, getExtentionSettings } from "@common/settings";
import { request, TestEndpointResponse } from "./reqwest";
import type { ISODateTime, Url } from "@common/types";

export interface ApiCheckPendingResponse {
  items: {
    id: string;
    url: Url;
    title: string;
    addedAt: ISODateTime;
  }[];
  total: number;
}
export interface PendingResponseInStorage extends ApiCheckPendingResponse {
  fetchedAt: number;
  error: string;
}

const log = bgRootlog.child("pending");

export async function testPending(pendingUrl: Url, token?: string): Promise<TestEndpointResponse> {
  const responseData = await request<ApiCheckPendingResponse>(pendingUrl, {
    token,
    timeoutMs: 15000,
  });
  if (!responseData.ok) {
    return {
      ok: false,
      text: `pending ✗ ${responseData.messages.toString()}`,
    };
  }
  return {
    ok: true,
    text: `pending ✓ (${responseData.data.items.length} items)`,
  };
}

let pendingPromise: Promise<Result<ApiCheckPendingResponse>> | null = null;
export function refreshPending(): Promise<Result<ApiCheckPendingResponse>> {
  log.debug("Periodic refresh alarm fired");

  if (pendingPromise) return pendingPromise;

  pendingPromise = (async () => {
    const extentionSettings = await getExtentionSettings();
    const endpoint = getEndpoint(extentionSettings);
    const { pending: previousPending } = (await browser.storage.local.get({ pending: null })) as {
      pending: PendingResponseInStorage;
    };

    if (!endpoint.pending) {
      log.debug("Pending endpoint not configured");
      await browser.storage.local.set({
        pending: { items: [], total: 0, fetchedAt: Date.now(), error: null },
      });
      return createError({ logger: log, message: "Pending endpoint not configured" });
    }
    try {
      log.debug("Refreshing pending list");
      const done = log.time("pending refresh");
      const data = await request<ApiCheckPendingResponse>(endpoint.pending, {
        token: extentionSettings.apiToken,
        timeoutMs: 20000,
      });
      if (data.ok === false) {
        return data;
      }

      const pending = data.data;
      done({
        fetched: pending.items.length,
        total: pending.total,
        limit: extentionSettings.pendingLimit,
      });
      log.debug(
        `Pending list refreshed: ${pending.items.length} item${pending.items.length === 1 ? "" : "s"}`,
      );
      await browser.storage.local.set({
        pending: {
          items: pending.items.slice(0, extentionSettings.pendingLimit),
          total: pending.items.length,
          fetchedAt: Date.now(),
          error: null,
        },
      });
      return data;
    } catch (e) {
      const errorMessage = isStandardError(e) ? e.message : String(e);
      log.warn("Pending list refresh failed", errorMessage);
      await browser.storage.local.set({
        pending: {
          items: previousPending?.items || [],
          total: previousPending?.total || 0,
          fetchedAt: previousPending?.fetchedAt || null,
          error: errorMessage,
        },
      });
      return createError({
        logger: log,
        message: errorMessage,
        extra: e,
      });
    }
  })().finally(() => {
    pendingPromise = null;
  });
  return pendingPromise;
}
