import { WebRequest } from "webextension-polyfill";
import browser from "webextension-polyfill";

import { err, ok, isStandardError, wrapErr, type Result } from "@common/error";
import { bgRootlog } from "@common/log";
import { reqwest, TestEndpointResponse } from "./reqwest";
import type { ArchiveResponse, PageDetail, PageItem } from "@common/api-types";
import type { IdLessTag, Int, Int64, Vec } from "@common/types";
import { session_storage_delete, session_storage_get, session_storage_set } from "@common/storage";
import { errorIfServerUnconfigured, getExtensionSettings } from "@common/settings";
import { canonicalizeUrl, createUrl, extractTabUrl, sha256 } from "@common/index";
import { Screenshot, takeScreenshot } from "./screenshot";
import { injectBanner } from "./browser-scripting";
import { updateBadge } from "./badge";
import { collectPage, type Page } from "./content-scripts";
import { createPage, pageLookup } from "./page";
import { setRemotePageTag } from "./tags";

const log = bgRootlog.child("archive");
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

export interface ArchiveResult {
  response: ArchiveResponse;
  warnings: string[];
}

const busyTabs = new Set<Int>();

const sleep = (ms: Int) => new Promise((resolve) => setTimeout(resolve, ms));
const headerMemory = new Map<Int, Partial<HeadersDetails>>();

function mergeTags(...lists: readonly (readonly IdLessTag[])[]): IdLessTag[] {
  const byName = new Map<string, IdLessTag>();
  for (const list of lists) for (const tag of list) byName.set(tag.name, tag);
  return [...byName.values()];
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

/**
 * Capture the current tab and upload it as a new version of `pageId`.
 *
 * The page itself must already exist; use `createPage` or `resolvePageForArchive`
 * first. Failures are returned as a `Result`, never thrown.
 */
export async function archivePage(
  tabId: Int,
  pageId: Int64,
  { pendingId }: { pendingId?: Int64 } = {},
): Promise<Result<ArchiveResult>> {
  const {
    serverUrl,
    token,
    includeScreenshot,
    includeSensitiveHeaders,
    screenshotFormat,
    fullPageScreenshot,
    jpegQuality,
    includeResponseHeaders,
    includeRequestHeaders,
    requestTimeoutSec,
    saveAssets,
  } = await getExtensionSettings();
  const [, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return wrapErr(serverUnconfigured);

  const [url, error] = await extractTabUrl(tabId, log);
  if (error) return wrapErr(error);

  if (busyTabs.has(tabId)) {
    return err({
      logger: log,
      reason: "archive_already_in_progress",
      detail: "An archive is already in progress for this tab",
      extra: { tabId },
    });
  }

  busyTabs.add(tabId);
  const measure = log.time("archive tab");

  try {
    await session_storage_delete(`archiveError:${tabId}`);

    const tab = await browser.tabs.get(tabId);
    log.info("Archiving page", { tabId, pageId, url, title: tab.title });

    await updateBadge({ tabId, text: "…", color: "#5f6368", title: "Archiving…" });

    const doneCollect = log.time("collect page");
    let results: browser.Scripting.InjectionResult[];
    try {
      results = await browser.scripting.executeScript({ target: { tabId }, func: collectPage });
    } catch (e) {
      const errorMessage = isStandardError(e) ? e.message : e;
      return err({
        logger: log,
        reason: "execute_script_collect_page",
        detail: `Could not read the page (${String(errorMessage)}). If this is Firefox, make sure site access is granted in the preferences.`,
      });
    }
    doneCollect(`fetch ${results?.[0]?.result ? "ok" : "empty"}`);

    const page = results?.[0]?.result as Page | undefined;
    if (!page) {
      return err({
        logger: log,
        reason: "page_content_undefined",
        detail: "Could not read the page content.",
      });
    }

    const warnings: string[] = [];
    let maybeScreenshot: Screenshot | null = null;

    if (includeScreenshot) {
      const doneShot = log.time("screenshot");
      const [shot] = await takeScreenshot({
        tab,
        page,
        screenshotFormat,
        fullPageScreenshot,
        jpegQuality,
        warnings,
      });
      if (shot) doneShot(shot.ext, shot.blob.size);
      maybeScreenshot = shot;
    }

    const headers = await getHeadersWithDetails(tabId);
    if (!headers) {
      const message =
        "No request headers recorded for this tab (page was loaded before the extension started)";
      log.warn(message);
      warnings.push(message);
    } else if (headers.url && canonicalizeUrl(headers.url) !== canonicalizeUrl(page.url)) {
      const message =
        "Recorded headers belong to a different URL (page navigated via script/history browser)";
      log.warn(message);
      warnings.push(message);
    }

    const { html, title, url: pageUrl, scrollWidth, scrollHeight, ...pageInfo } = page;
    const htmlBlob = new Blob([html], { type: "text/html;charset=utf-8" });
    const metadata = {
      schema: 1,
      url: pageUrl,
      title,
      capturedAt: new Date().toISOString(),
      page: { ...pageInfo, scroll: { width: scrollWidth, height: scrollHeight } },
      request:
        headers && includeRequestHeaders
          ? {
              method: headers.method || "GET",
              url: headers.url,
              headers: await headersToObject(headers.requestHeaders, includeSensitiveHeaders),
            }
          : null,
      response:
        headers && includeResponseHeaders
          ? {
              statusCode: headers.statusCode ?? null,
              statusLine: headers.statusLine ?? null,
              headers: await headersToObject(headers.responseHeaders, includeSensitiveHeaders),
            }
          : null,
      sensitiveHeadersRedacted: !includeSensitiveHeaders,
      extension: {
        name: browser.runtime.getManifest().name,
        version: browser.runtime.getManifest().version,
        browser: typeof browser.tabs.captureTab === "function" ? "firefox" : "chromium",
      },
      files: {
        html: { name: "page.html", size: htmlBlob.size, sha256: await sha256(htmlBlob) },
        screenshot:
          maybeScreenshot !== null
            ? {
                name: `screenshot.${maybeScreenshot.ext}`,
                size: maybeScreenshot.blob.size,
                sha256: await sha256(maybeScreenshot.blob),
                format: maybeScreenshot.format,
              }
            : null,
      },
      warnings,
    };

    const form = new FormData();
    form.append("html", htmlBlob);
    form.append("metadata", JSON.stringify(metadata));
    form.append("saveAssets", saveAssets ? "true" : "false");
    if (title.trim()) form.append("title", title);
    if (pendingId !== undefined) form.append("pendingId", String(pendingId));
    if (maybeScreenshot !== null) {
      form.append("screenshot", maybeScreenshot.blob, `screenshot.${maybeScreenshot.ext}`);
    }

    log.info("Uploading archive", {
      pageId,
      url: pageUrl,
      htmlBytes: htmlBlob.size,
      screenshotBytes: maybeScreenshot !== null ? maybeScreenshot.blob.size : null,
    });

    const [response, uploadError] = await reqwest<ArchiveResponse>(
      createUrl(serverUrl, `/api/page/${pageId}/capture`),
      {
        method: "POST",
        body: form,
        token,
        timeoutMs: (Number(requestTimeoutSec) || 120) * 1000,
      },
    );
    if (uploadError) return wrapErr(uploadError);

    return ok({ response, warnings });
  } catch (e) {
    log.error("Archive request failed", e);
    return err({
      logger: log,
      reason: "archive_failed",
      detail: "Archive request failed",
      extra: e,
    });
  } finally {
    busyTabs.delete(tabId);
    measure();
  }
}

interface ResolvedPage {
  page: PageItem;
  created: boolean;
}

/**
 * Find the server's page row for the tab, creating an unsaved link when needed.
 * This keeps the archive-only actions working without a separate save step.
 */
async function resolvePageForArchive(
  tabId: Int,
  { tags }: { tags?: readonly IdLessTag[] } = {},
): Promise<Result<ResolvedPage>> {
  const { serverUrl, token } = await getExtensionSettings();
  const [, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return wrapErr(serverUnconfigured);

  const [url, urlError] = await extractTabUrl(tabId, log);
  if (urlError) return wrapErr(urlError);

  const canonicalUrl = canonicalizeUrl(url);
  const [page, lookupError] = await pageLookup(canonicalUrl, { serverUrl, token });

  if (!lookupError) return ok({ page, created: false });
  if (lookupError.reason !== "not_found") return wrapErr(lookupError);

  const tab = await browser.tabs.get(tabId);
  const [created, createError] = await createPage({
    url: canonicalUrl,
    displayTitle: tab.title?.trim() || canonicalUrl,
    tags,
  });
  if (createError) return wrapErr(createError);
  return ok({ page: created, created: true });
}

export type ArchiveTab = Awaited<ReturnType<typeof archiveWithFeedback>>;

async function archiveTab(
  tabId: Int,
  { tags, pendingId }: { tags?: readonly IdLessTag[]; pendingId?: Int64 } = {},
) {
  const [resolved, resolveError] = await resolvePageForArchive(tabId, { tags });
  if (resolveError) return wrapErr(resolveError);

  const [result, archiveError] = await archivePage(tabId, resolved.page.id, { pendingId });
  if (archiveError) return wrapErr(archiveError);

  // Tags chosen for an already-saved page are merged after the capture, so an
  // archive failure does not silently rewrite the page's tags.
  if (!resolved.created && tags?.length) {
    const merged = mergeTags(resolved.page.tags, tags);
    const [, tagError] = await setRemotePageTag(resolved.page.id, merged);
    if (tagError) {
      result.warnings.push(`Snapshot saved, but tags could not be updated: ${tagError.detail}`);
    }
  }

  return ok(result);
}

async function reportArchiveFailure(
  tabId: Int,
  errorMessage: string,
  { toast }: { toast: boolean },
) {
  await session_storage_set(`archiveError:${tabId}`, {
    message: errorMessage,
    time: Date.now(),
  });
  await updateBadge({
    tabId,
    text: "!",
    color: "#d93025",
    title: `Archive failed: ${errorMessage}`,
  });

  if (toast)
    await injectBanner(tabId, {
      mode: "toast",
      kind: "err",
      text: `Archive failed: ${errorMessage}`,
    });
}

export async function archiveWithFeedback(
  tabId: Int,
  { toast, tags, pendingId }: { toast: boolean; tags?: Vec<IdLessTag>; pendingId?: Int64 },
) {
  try {
    const [res, error] = await archiveTab(tabId, { tags, pendingId });
    if (error !== null) {
      await reportArchiveFailure(tabId, error.detail, { toast });
      return wrapErr(error);
    }

    if (toast) {
      const n = res.response.version;
      const text = `Archived ✓${n ? ` (${n} version${n === 1 ? "" : "s"})` : ""}`;
      log.info(text);
      await injectBanner(tabId, { mode: "toast", kind: "ok", text });
    }
    return ok(res);
  } catch (e) {
    const errorMessage = isStandardError(e) ? e.message : String(e);
    log.error("Archive failed", errorMessage, e);
    await reportArchiveFailure(tabId, errorMessage, { toast });

    return err({
      reason: "archive_failed",
      logger: log,
      detail: errorMessage,
      extra: e,
    });
  }
}

export async function openAndArchive(
  url: string,
  { tags = [], pendingId }: { tags?: string[]; pendingId?: Int64 } = {},
) {
  const tab = await browser.tabs.create({ url, active: true });
  logCapture.info("Opened new tab for direct archive", { url, tabId: tab.id });
  const tagObjects: Vec<IdLessTag> = tags.map((name) => ({ name, color: null }));
  await session_storage_set(`open:${tab.id}`, {
    url,
    at: Date.now(),
    tags: tagObjects,
    pendingId,
  });
}

/** Pending id parked by `handleOpened` for the banner's archive action. */
const pendingArchiveKey = (tabId: Int) => `archivePending:${tabId}`;

export async function takePendingArchiveId(tabId: Int): Promise<Int64 | undefined> {
  const key = pendingArchiveKey(tabId);
  const pendingId = await session_storage_get(key);
  await session_storage_delete(key);
  return typeof pendingId === "number" ? pendingId : undefined;
}

export function clearPendingArchiveId(tabId: Int): Promise<void> {
  return session_storage_delete(pendingArchiveKey(tabId));
}

export async function handleOpened(tabId: Int) {
  const opened = (await session_storage_get(`open:${tabId}`)) as {
    url: string;
    at: number;
    tags?: Vec<IdLessTag>;
    pendingId?: Int64;
  } | null;
  await session_storage_delete(`open:${tabId}`);

  const { serverUrl, directArchiveMode, directArchiveDelaySec, defaultTags, token } =
    await getExtensionSettings();
  const [, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return wrapErr(serverUnconfigured);

  await sleep(Math.max(0, Number(directArchiveDelaySec) || 0) * 1000);

  logCapture.debug(`Direct-archive mode: ${directArchiveMode}`, { tabId });

  if (directArchiveMode === "auto") {
    void archiveWithFeedback(tabId, {
      toast: true,
      tags: opened?.tags ?? undefined,
      pendingId: opened?.pendingId,
    });
  } else {
    // The banner sends a separate message when the user confirms; keep the
    // pending id around so that archive also dequeues the item.
    if (opened?.pendingId !== undefined) {
      await session_storage_set(pendingArchiveKey(tabId), opened.pendingId);
    }

    const defaults = mergeTags(defaultTags, opened?.tags ?? []);

    const [urlToLookUp, error] = await extractTabUrl(tabId, log);
    if (error) return wrapErr(error);
    const url = canonicalizeUrl(urlToLookUp);

    const [page, lookupError] = await pageLookup(url, { serverUrl, token });
    const siteTags = lookupError === null ? page.tags : [];
    await injectBanner(tabId, {
      kind: "",
      mode: "prompt",
      text: "Archive this page?",
      tags: mergeTags(siteTags, defaults),
    });
  }
}

export async function testPageStatus(
  serverUrl: URL,
  {
    token,
    queryUrl = "https://example.com/",
  }: {
    token?: string;
    queryUrl?: string;
  } = {},
): Promise<TestEndpointResponse> {
  const reqUrl = createUrl(serverUrl, "/api/page/lookup");
  reqUrl.searchParams.set("url", queryUrl);
  const [response, error] = await reqwest<PageDetail>(reqUrl, {
    token,
    timeoutMs: 20000,
  });

  if (error) {
    return {
      ok: false,
      text: `page check ✗ ${error.detail}`,
    };
  }
  return {
    ok: true,
    text: `page check ✓ [for "${queryUrl}" ${response.captureCount} capture(s)]`,
  };
}
