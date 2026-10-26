import { WebRequest } from "webextension-polyfill";
import browser from "webextension-polyfill";

import { createError, createOk, isStandardError, type Result } from "@common/error";
import { bgRootlog } from "@common/log";
import { request, TestEndpointResponse } from "./reqwest";
import { Int, Int64, UrlStr, Option, Vec } from "@common/types";
import { session_storage_delete, session_storage_get, session_storage_set } from "@common/storage";
import {
  errorIfServerUnconfigured,
  getExtensionSettings,
  isServerConfigured,
} from "@common/settings";
import { canonicalizeUrl, createUrl, extractTabUrl, isArchivable, sha256 } from "@common/index";
import type { TagDto, IdLessTag } from "./tags";
import { Screenshot, takeScreenshot } from "./screenshot";
import { injectBanner } from "./browser-scripting";
import { updateBadge } from "./badge";
import { collectPage, type Page } from "./content-scripts";

const log = bgRootlog.child("archive");
const logArchiveStatus = log.child("status");

const logCapture = bgRootlog.child("capture");

export interface HeadersDetails {
  requestId: string;
  url: string;
  method: string;
  tabId: number;
  timeStamp: number;
  requestHeaders?: WebRequest.HttpHeaders;
  statusLine: string;
  responseHeaders?: WebRequest.HttpHeaders;
  statusCode: number;
}

export interface Dedup {
  html: boolean;
  screenshot: Option<boolean>;
}

export interface ApiArchiveResponse {
  captureId: Int64;
  pageId: Int64;
  version: Int64;
  deduplicated: Dedup;
}

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

// interface ArchiveErrorStatus {
//   state: "error" | "unsupported" | "unconfigured";
//   url: UrlStr;
//   error: string;
//   checkedAt: number;
// }

// export interface ArchiveOkStatus extends ApiPageDetail {
//   state: "ok";
//   checkedAt: number;
// }

// export type ArchiveStatus = ArchiveOkStatus | ArchiveErrorStatus;

// export interface ArchiveOkStatus extends ApiPageDetail {
//   state: "ok";
//   checkedAt: number;
// }

const busyTabs = new Set<Int>();
const inflight = new Map<string, Promise<Result<ApiPageDetail | null>>>();
const sleep = (ms: Int) => new Promise((resolve) => setTimeout(resolve, ms));
const headerMemory = new Map<Int, Partial<HeadersDetails>>();

// TODO: todo are merge function required
export function mergeTags(...lists: Vec<TagDto>[]): Vec<TagDto> {
  const byId = new Map<Int64, TagDto>();
  for (const list of lists) {
    for (const tag of list) {
      if (!byId.has(tag.id)) byId.set(tag.id, tag);
    }
  }
  return [...byId.values()];
}
export function mergeTagNames(...lists: Vec<IdLessTag>[]): IdLessTag[] {
  const byName = new Map<string, IdLessTag>();
  for (const list of lists) for (const tag of list) byName.set(tag.name, tag);
  return [...byName.values()];
}
export function mergeTagNamesNames(...lists: Vec<IdLessTag>[]): string[] {
  return [...new Set(lists.flat().map((t) => t.name))];
}

export function deleteHeaderMemory(tabId: Int) {
  headerMemory.delete(tabId);
}

async function getHeadersWithDetails(tabId: Int): Promise<Partial<HeadersDetails> | null> {
  return headerMemory.get(tabId) ?? (await session_storage_get(`hdr:${tabId}`)) ?? null;
}

async function headersToObject(
  headerList: WebRequest.HttpHeaders | null | undefined,
  keepSensitive: boolean = false,
): Promise<Record<string, string>> {
  const extensionSettings = await getExtensionSettings();

  const headersMap: Record<string, string> = {};

  for (const { name, value } of headerList || []) {
    const lowerName = name.toLowerCase();
    const headerValue =
      !keepSensitive && extensionSettings.sensitiveHeaders.has(lowerName)
        ? "[redacted]"
        : (value ?? "");

    if (name in headersMap) {
      const separator = lowerName === "set-cookie" ? "\n" : ", ";
      headersMap[name] = `${headersMap[name]}${separator}${headerValue}`;
    } else {
      headersMap[name] = headerValue;
    }
  }

  return headersMap;
}

export function patchHeaders(tabId: Int, requestId: string, patch: Partial<HeadersDetails>): void {
  const current = headerMemory.get(tabId);
  const next: Partial<HeadersDetails> = {
    ...(current && current.requestId === requestId ? current : { requestId }),
    ...patch,
  };
  headerMemory.set(tabId, next);
  session_storage_set(`hdr:${tabId}`, next).catch(() => {});
}

async function archiveTab(
  tabId: Int,
  { tags }: { tags?: Vec<IdLessTag> } = {},
): Promise<
  Result<{
    response: ApiArchiveResponse;
    warnings: string[];
  }>
> {
  if (busyTabs.has(tabId)) {
    return createError({
      logger: log,
      message: "An archive is already in progress for this tab",
      extra: { tabId },
    });
  }

  busyTabs.add(tabId);
  const measure = log.time("archive tab");

  try {
    await session_storage_delete(`archiveError:${tabId}`);

    const extensionSettings = await getExtensionSettings();
    if (!isServerConfigured(extensionSettings)) {
      log.debug("Server is not configured");
      return createError({
        logger: log,
        message: "Server is not configured. Open the extension preferences.",
      });
    }

    const tab = await browser.tabs.get(tabId);
    const url = tab.url;

    if (url === undefined || !isArchivable(url)) {
      return createError({
        logger: log,
        message: "Only http(s) pages can be archived.",
        extra: { url: tab.url },
      });
    }

    log.info("Archiving page", { tabId, url, title: tab.title });

    await updateBadge({
      tabId,
      text: "…",
      color: "#5f6368",
      title: "Archiving…",
    });

    let results: browser.Scripting.InjectionResult[];
    const doneCollect = log.time("collect page");
    try {
      results = await browser.scripting.executeScript({ target: { tabId }, func: collectPage });
    } catch (e) {
      const errorMessage = isStandardError(e) ? e.message : e;
      return createError({
        logger: log,
        message: `Could not read the page (${errorMessage}). If this is Firefox, make sure site access is granted in the preferences.`,
      });
    }
    doneCollect(`fetch ${results?.[0]?.result ? "ok" : "empty"}`);
    const page = results?.[0]?.result as Page | undefined;
    if (!page) {
      return createError({
        logger: log,
        message: "Could not read the page content.",
      });
    }

    const warnings: string[] = [];
    let maybeScreenshot: Result<Screenshot> | null = null;

    if (extensionSettings.includeScreenshot) {
      const doneShot = log.time("screenshot");
      maybeScreenshot = await takeScreenshot({ tab, extensionSettings, page, warnings });
      if (maybeScreenshot.ok === true) {
        doneShot(maybeScreenshot.data.ext, maybeScreenshot.data.blob.size);
      }
    }

    const headers = await getHeadersWithDetails(tabId);
    if (!headers) {
      log.warn(
        "No request headers recorded for this tab (page was loaded before the extension started)",
      );
      warnings.push(
        "No request headers recorded for this tab (page was loaded before the extension started)",
      );
    } else if (canonicalizeUrl(headers.url as UrlStr) !== canonicalizeUrl(page.url)) {
      log.warn(
        "Recorded headers belong to a different URL (page navigated via script/history browser)",
      );
      warnings.push(
        "Recorded headers belong to a different URL (page navigated via script/history browser)",
      );
    }

    const { html, title, url: pageUrl, scrollWidth, scrollHeight, ...pageInfo } = page;
    const htmlBlob = new Blob([html], { type: "text/html;charset=utf-8" });
    const metadata = {
      schema: 1,
      url: pageUrl,
      title,
      capturedAt: new Date().toISOString(),
      page: { ...pageInfo, scroll: { width: scrollWidth, height: scrollHeight } },
      request: headers
        ? {
            method: headers.method || "GET",
            url: headers.url,
            headers: await headersToObject(
              headers.requestHeaders,
              extensionSettings.includeSensitiveHeaders,
            ),
          }
        : null,
      response:
        headers && extensionSettings.includeResponseHeaders
          ? {
              statusCode: headers.statusCode ?? null,
              statusLine: headers.statusLine ?? null,
              headers: await headersToObject(
                headers.responseHeaders,
                extensionSettings.includeSensitiveHeaders,
              ),
            }
          : null,
      sensitiveHeadersRedacted: !extensionSettings.includeSensitiveHeaders,
      extension: {
        name: browser.runtime.getManifest().name,
        version: browser.runtime.getManifest().version,
        browser: typeof browser.tabs.captureTab === "function" ? "firefox" : "chromium",
      },
      files: {
        html: { name: "page.html", size: htmlBlob.size, sha256: await sha256(htmlBlob) },
        screenshot:
          maybeScreenshot?.ok === true
            ? {
                name: `screenshot.${maybeScreenshot.data.ext}`,
                size: maybeScreenshot.data.blob.size,
                sha256: await sha256(maybeScreenshot.data.blob),
                format: maybeScreenshot.data.format,
              }
            : null,
      },
      warnings,
    };

    const formData = new FormData();
    formData.append("html", htmlBlob);
    formData.append("url", url);
    formData.append("title", title);

    if (tags?.length) {
      formData.append("tags", JSON.stringify(tags.map((v) => v.name)));
    }

    if (maybeScreenshot?.ok) {
      formData.append("screenshot-format", maybeScreenshot.data.format);
      formData.append(
        "screenshot",
        maybeScreenshot.data.blob,
        `screenshot.${maybeScreenshot.data.ext}`,
      );
    }
    formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    // Includes tags queued via the pending queue (created server-side if unknown).

    log.info("Uploading archive", {
      url: pageUrl,
      htmlBytes: htmlBlob.size,
      screenshotBytes: maybeScreenshot?.ok ? maybeScreenshot.data.blob.size : null,
    });

    const result = await request<ApiArchiveResponse>(
      createUrl(extensionSettings.serverUrl, "/api/archive"),
      {
        method: "POST",
        body: formData,
        token: extensionSettings.token,
        timeoutMs: (Number(extensionSettings.requestTimeoutSec) || 120) * 1000,
      },
    );

    if (result.ok === false) {
      return result;
    }

    return createOk({
      response: result.data,
      warnings,
    });
  } catch (e) {
    log.error("Archive request failed", e);
    return createError({
      logger: log,
      message: "Archive request failed",
      extra: e,
    });
  } finally {
    busyTabs.delete(tabId);
    measure();
  }
}

export async function archiveWithFeedback(
  tabId: Int,
  { toast, tags }: { toast: boolean; tags?: Vec<IdLessTag> },
): Promise<
  Result<{
    response: ApiArchiveResponse;
    warnings: string[];
  }>
> {
  try {
    const result = await archiveTab(tabId, { tags });
    if (result.ok === false) {
      return result;
    }

    if (toast) {
      const n = result.data.response.version;
      log.error(`Archived ✓${n ? ` (${n} version${n === 1 ? "" : "s"})` : ""}`);
      injectBanner(tabId, {
        mode: "toast",
        kind: "ok",
        text: `Archived ✓${n ? ` (${n} version${n === 1 ? "" : "s"})` : ""}`,
      });
    }
    return createOk(result.data);
  } catch (e) {
    const errorMessage = isStandardError(e) ? e.message : String(e);
    log.error("Archive failed", errorMessage, e);

    await session_storage_set(`archiveError:${tabId}`, {
      message: errorMessage,
      time: Date.now(),
    });
    updateBadge({
      tabId,
      text: "!",
      color: "#d93025",
      title: `Archive failed: ${errorMessage}`,
    });

    if (toast)
      injectBanner(tabId, {
        mode: "toast",
        kind: "err",
        text: `Archive failed: ${errorMessage}`,
      });

    return createError({
      logger: log,
      message: errorMessage,
      extra: e,
    });
  }
}

/**
 * Returns Result<null> if no page found for given lookup url
 */
export async function pageLookup(tabId: Int): Promise<Result<ApiPageDetail | null>> {
  const { serverUrl, token } = await getExtensionSettings();
  const serverUnconfigured = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return serverUnconfigured;

  const urlResult = await extractTabUrl(tabId, log);
  if (!urlResult.ok) return urlResult;
  let urlToLookUp = urlResult.data;

  const url = canonicalizeUrl(urlToLookUp);
  const urlShaHash = await sha256(url);

  const key = urlShaHash;
  if (inflight.has(key)) {
    logArchiveStatus.debug("Joining in-flight status check", { url: url });
    const status = await inflight.get(key)!;
    return status;
  }

  const inflightStatusPromise: Promise<Result<ApiPageDetail | null>> = (async () => {
    logArchiveStatus.debug("Checking archive status", { url: url });

    const done = logArchiveStatus.time("status check");

    const reqUrl = createUrl(serverUrl, "/api/pages/lookup");
    reqUrl.searchParams.set("url", url);

    // TODO: check what is returned if page not found
    let pageResult = await request<ApiPageDetail | null>(reqUrl, {
      token,
      timeoutMs: 20000,
    });
    done();

    logArchiveStatus[pageResult.ok ? "debug" : "warn"](pageResult);

    await session_storage_set(`status:${urlShaHash}`, pageResult);

    return pageResult;
  })().finally(() => inflight.delete(key));

  inflight.set(key, inflightStatusPromise);
  return inflightStatusPromise;
}

export async function openAndArchive(url: UrlStr, tags: string[] = []) {
  const tab = await browser.tabs.create({ url, active: true });
  logCapture.info("Opened new tab for direct archive", { url, tabId: tab.id });
  await session_storage_set(`open:${tab.id}`, { url, at: Date.now(), tags });
}

export async function handleOpened(tabId: Int) {
  const opened = (await session_storage_get(`open:${tabId}`)) as {
    url: UrlStr;
    at: number;
    tags?: Vec<IdLessTag>;
  };
  await session_storage_delete(`open:${tabId}`);

  const { serverUrl, directArchiveMode, directArchiveDelaySec, defaultTags } =
    await getExtensionSettings();
  const serverUnconfigured = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return serverUnconfigured;
  await getExtensionSettings();

  await sleep(Math.max(0, Number(directArchiveDelaySec) || 0) * 1000);

  logCapture.debug(`Direct-archive mode: ${directArchiveMode}`, { tabId });

  if (directArchiveMode === "auto") {
    // Per-URL pending tags are merged inside archiveTab automatically.
    archiveWithFeedback(tabId, { toast: true, tags: opened?.tags ?? undefined });
  } else {
    // Prompt mode: offer a tag chip row (site's current/default tags, preselected)
    // before confirming; chosen tags are sent with ARCHIVE_FROM_PAGE.
    const defaults = mergeTagNames(Vec.from(defaultTags), opened?.tags ?? []);
    const status = await pageLookup(tabId);
    const siteTags = status.ok === true && status.data ? status.data.tags : [];
    injectBanner(tabId, {
      kind: "",
      mode: "prompt",
      text: "Archive this page?",
      tags: mergeTagNames(siteTags, defaults),
    });
  }
}

export async function testPageStatus(
  serverUrl: UrlStr,
  {
    token,
    queryUrl = "https://example.com/",
  }: {
    token?: string;
    queryUrl?: UrlStr;
  } = {},
): Promise<TestEndpointResponse> {
  const url = URL.parse(serverUrl);
  if (!url) {
    return {
      ok: false,
      text: `page check ✗ Cannot parse ${serverUrl} as URL`,
    };
  }

  const reqUrl = createUrl(url, "/api/pages/lookup");
  reqUrl.searchParams.set("url", queryUrl);
  const responseData = await request<ApiPageDetail>(reqUrl, {
    token,
    timeoutMs: 20000,
  });

  if (!responseData.ok) {
    return {
      ok: false,
      text: `page check ✗ ${responseData.messages.toString()}`,
    };
  }
  return {
    ok: true,
    text: `page check ✓ [for "${queryUrl}" ${responseData.data.captureCount} capture(s)]`,
  };
}
