import { ok, wrapErr, type Err, type Result } from "@common/error";
import { bgRootlog } from "@common/log";
import { reqwest } from "./reqwest";
import type {
  CaptureHistoryResponse,
  PageDetail,
  PageItem,
  PatchPageRequest,
} from "@common/api-types";
import type { IdLessTag, Int, Int64 } from "@common/types";
import { session_storage_set } from "@common/storage";
import { errorIfServerUnconfigured, getExtensionSettings } from "@common/settings";
import { canonicalizeUrl, createUrl, extractTabUrl, sha256 } from "@common/index";

const log = bgRootlog.child("page");

export type PageLookup = Result<PageDetail>;
export type PageLookupFull = Result<readonly [PageDetail, CaptureHistoryResponse]>;
export type UpdatePage = Result<boolean>;

/** Everything an API call needs; callers usually already have settings loaded. */
export interface ApiContext {
  serverUrl: URL;
  token: string;
}

export interface CreatePageInput {
  url: string;
  displayTitle: string;
  description?: string;
  /** Numeric collection id as a string; `null` or empty means Unsorted. */
  collectionId?: string | null;
  pinned?: boolean;
  tags?: readonly IdLessTag[];
}

const inflight = new Map<string, ReturnType<typeof fetchPageAndVersions>>();

function isNotFound(error: Err): boolean {
  return (
    error.reason === "reqwest_api_error" &&
    typeof error.extra === "object" &&
    error.extra !== null &&
    (error.extra as { error?: { code?: string } }).error?.code === "not_found"
  );
}

/** `GET /api/page/lookup?url=...` — the saved page plus its latest capture. */
export async function pageLookup(url: string, { token, serverUrl }: ApiContext) {
  log.debug("Page lookup", { url });

  const reqUrl = createUrl(serverUrl, "/api/page/lookup");
  reqUrl.searchParams.set("url", url);

  const done = log.time("status check");
  const [page, error] = await reqwest<PageDetail>(reqUrl, {
    token,
    timeoutMs: 20000,
  });
  done();

  if (error) {
    return wrapErr(isNotFound(error) ? { ...error, reason: "not_found" as const } : error);
  }
  return ok(page);
}

/** `GET /api/page/:id/capture` — capture history, newest first. */
export async function pageVersions(pageId: Int64, { token, serverUrl }: ApiContext) {
  log.debug("Page version lookup", { pageId });

  const done = log.time("page version");
  const [history, error] = await reqwest<CaptureHistoryResponse>(
    createUrl(serverUrl, `/api/page/${pageId}/capture`),
    { token, timeoutMs: 20000 },
  );
  done();

  if (error) {
    return wrapErr(isNotFound(error) ? { ...error, reason: "not_found" as const } : error);
  }
  return ok(history);
}

/** `POST /api/page` — create a link (or return the existing page for the URL). */
export async function createPage(input: CreatePageInput) {
  const { serverUrl, token } = await getExtensionSettings();
  const [, unconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (unconfigured !== null) return wrapErr(unconfigured);

  const form = new FormData();
  form.set("url", input.url);
  form.set("displayTitle", input.displayTitle);
  form.set("pinned", input.pinned ? "true" : "false");

  if (input.description) form.set("description", input.description);
  if (input.collectionId) form.set("collectionId", input.collectionId);
  if (input.tags?.length) form.set("tags", input.tags.map((tag) => tag.name).join(","));

  const [page, error] = await reqwest<PageItem>(createUrl(serverUrl, "/api/page"), {
    method: "POST",
    body: form,
    token,
    timeoutMs: 20000,
  });

  if (error) return wrapErr(error);
  return ok(page);
}

/** `PATCH /api/page/:id` — only the supplied fields change. */
export async function patchPage(id: Int64, patch: PatchPageRequest) {
  const { serverUrl, token } = await getExtensionSettings();
  const [, unconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (unconfigured !== null) return wrapErr(unconfigured);

  const [, error] = await reqwest<null>(createUrl(serverUrl, `/api/page/${id}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
    token,
    timeoutMs: 20000,
  });

  if (error) return wrapErr(error);
  return ok(true);
}

/** Single source of truth for the status-cache key. */
export async function statusCacheKey(canonicalUrl: string): Promise<string> {
  return `status:${await sha256(canonicalUrl)}`;
}

async function fetchPageAndVersions(url: string, cacheKey: string, ctx: ApiContext) {
  const [page, pageError] = await pageLookup(url, ctx);
  if (pageError) return wrapErr(pageError);

  let versions: CaptureHistoryResponse;
  if (page.captureCount === 0) {
    versions = { items: [], nextCursor: null };
  } else if (page.captureCount === 1 && page.latestCapture) {
    versions = { items: [page.latestCapture], nextCursor: null };
  } else {
    const [history, versionsError] = await pageVersions(page.id, ctx);
    if (versionsError) return wrapErr(versionsError);
    versions = history;
  }

  const out = ok([page, versions] as const);
  try {
    await session_storage_set(cacheKey, out);
  } catch (e) {
    log.warn("Cannot cache page status", e); // a cache failure must not fail the lookup
  }
  return out;
}

export async function pageLookupFull(tabId: Int): Promise<PageLookupFull> {
  const { serverUrl, token } = await getExtensionSettings();
  const [, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return wrapErr(serverUnconfigured);

  const [urlToLookUp, error] = await extractTabUrl(tabId, log);
  if (error) return wrapErr(error);

  const url = canonicalizeUrl(urlToLookUp);
  const cacheKey = await statusCacheKey(url);

  const existing = inflight.get(cacheKey);
  if (existing) {
    log.debug("Joining in-flight page check", { url });
    return existing;
  }

  const promise = fetchPageAndVersions(url, cacheKey, { serverUrl, token }).finally(() =>
    inflight.delete(cacheKey),
  );
  inflight.set(cacheKey, promise);

  // Remember which cache entry belongs to this tab so it can be cleaned up when
  // the tab closes (the tab's URL is no longer readable at that point).
  void session_storage_set(`statusKey:${tabId}`, cacheKey).catch((e) =>
    log.warn("Cannot cache tab status key", e),
  );
  return promise;
}
