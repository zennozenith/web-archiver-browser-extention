import { ok, wrapErr } from "@common/error";
import { bgRootlog } from "@common/log";
import { reqwest } from "./reqwest";
import { Int, Int64, Option, Page, Vec } from "@common/types";
import { session_storage_set } from "@common/storage";
import { errorIfServerUnconfigured, getExtensionSettings } from "@common/settings";
import { canonicalizeUrl, createUrl, extractTabUrl, sha256 } from "@common/index";
import { TagDto } from "./tags";

const log = bgRootlog.child("page");

export type PageLookup = Awaited<ReturnType<typeof pageLookup>>;
export type PageVersion = Awaited<ReturnType<typeof pageVersions>>;
export type PageLookupFull = Awaited<ReturnType<typeof pageLookupFull>>;

export interface ApiPageDto {
  id: Int64;
  url: string;
  host: string;
  title: Option<string>;
  captureCount: Int64;
  lastCapturedAt: Option<Int64>;
  tags: Vec<TagDto>;
}

export interface ApiCaptureSummary {
  id: Int64;
  version: Int64;
  capturedAt: Int64;
  title: Option<string>;
  statusCode: Option<string>;
  contentHash: Option<string>; // hex
  hasScreenshot: boolean;
}

export interface ApiPageDetail extends ApiPageDto {
  latestCapture: ApiCaptureSummary;
}

const inflight = new Map<string, ReturnType<typeof fetchPageAndVersions>>();

export async function pageLookup(
  canonicalizeLookupUrl: string,
  { token, serverUrl }: { serverUrl: URL; token: string },
) {
  let url = canonicalizeLookupUrl;
  log.debug("Page lookup", { url: url });

  const done = log.time("status check");

  const reqUrl = createUrl(serverUrl, "/api/pages/lookup");
  reqUrl.searchParams.set("url", url);

  let result = await reqwest<ApiPageDetail>(reqUrl, {
    token,
    timeoutMs: 20000,
  });
  done();

  log[result[1] ? "warn" : "debug"](result[1]);

  if (
    result[1] &&
    result[1].reason === "reqwest_api_error" &&
    result[1].extra.error.code === "not_found"
  ) {
    return wrapErr({
      ...result[1],
      reason: "not_found",
    });
  }

  return result;
}

export async function pageVersions(
  pageId: Int64,
  { token, serverUrl }: { serverUrl: URL; token: string },
) {
  log.debug("Page version lookup", { pageId });

  const done = log.time("page version");

  const reqUrl = createUrl(serverUrl, `/api/pages/${pageId}/captures`);

  let result = await reqwest<Page<ApiCaptureSummary>>(reqUrl, {
    token,
    timeoutMs: 20000,
  });
  done();

  log[result[1] ? "warn" : "debug"](result[1]);

  if (
    result[1] &&
    result[1].reason === "reqwest_api_error" &&
    result[1].extra.error.code === "not_found"
  ) {
    return wrapErr({
      ...result[1],
      reason: "not_found",
    });
  }

  return result;
}

/** Single source of truth for the status-cache key. */
export async function statusCacheKey(canonicalUrl: string): Promise<string> {
  return `status:${await sha256(canonicalUrl)}`;
}

async function fetchPageAndVersions(
  url: string,
  cacheKey: string,
  ctx: { serverUrl: URL; token: string },
) {
  const [page, pageError] = await pageLookup(url, ctx);
  if (pageError) return wrapErr(pageError);

  let versions: Page<ApiCaptureSummary>;
  if (page.captureCount === 1) {
    versions = { items: [page.latestCapture], nextCursor: null };
  } else {
    const [fetched, versionsError] = await pageVersions(page.id, ctx);
    if (versionsError) return wrapErr(versionsError);
    versions = fetched;
  }

  const out = ok([page, versions] as const);
  try {
    await session_storage_set(cacheKey, out);
  } catch (e) {
    log.warn("Cannot cache page status", e); // a cache failure must not fail the lookup
  }
  return out;
}

export async function pageLookupFull(tabId: Int) {
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
  return promise;
}
