import { WebRequest } from "webextension-polyfill";
import browser from "webextension-polyfill";

import { err, ok, isStandardError, wrapErr } from "@common/error";
import { bgRootlog } from "@common/log";
import { reqwest, TestEndpointResponse } from "./reqwest";
import { Int, Int64, UrlStr, Option, Vec } from "@common/types";
import { session_storage_delete, session_storage_get, session_storage_set } from "@common/storage";
import { errorIfServerUnconfigured, getExtensionSettings } from "@common/settings";
import { canonicalizeUrl, createUrl, extractTabUrl, sha256 } from "@common/index";
import type { TagDto, IdLessTag } from "./tags";
import { Screenshot, takeScreenshot } from "./screenshot";
import { injectBanner } from "./browser-scripting";
import { updateBadge } from "./badge";
import { collectPage, type Page } from "./content-scripts";
import { ApiPageDetail, pageLookup } from "./page";

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

const busyTabs = new Set<Int>();

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

async function archiveTab(tabId: Int, { tags }: { tags?: Vec<IdLessTag> } = {}) {
  const {
    serverUrl,
    token,
    includeScreenshot,
    includeSensitiveHeaders,
    screenshotFormat,
    fullPageScreenshot,
    jpegQuality,
    includeResponseHeaders,
    requestTimeoutSec,
    saveAssets,
  } = await getExtensionSettings();
  const [_, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
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
      return err({
        logger: log,
        reason: "execute_script_collect_page",
        detail: `Could not read the page (${errorMessage}). If this is Firefox, make sure site access is granted in the preferences.`,
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
      const [shot, error] = await takeScreenshot({
        tab,
        page,
        screenshotFormat,
        fullPageScreenshot,
        jpegQuality,
        warnings,
      });
      if (error === null) {
        doneShot(shot.ext, shot.blob.size);
      }
      maybeScreenshot = shot;
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

    const formData = new FormData();
    formData.append("html", htmlBlob);
    formData.append("url", canonicalizeUrl(url));
    formData.append("title", title);
    formData.append("save-assets", saveAssets ? "true" : "false");

    if (tags?.length) {
      formData.append("tags", JSON.stringify(tags.map((v) => v.name)));
    }

    if (maybeScreenshot !== null) {
      formData.append("screenshot-format", maybeScreenshot.format);
      formData.append("screenshot", maybeScreenshot.blob, `screenshot.${maybeScreenshot.ext}`);
    }
    formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    // Includes tags queued via the pending queue (created server-side if unknown).

    log.info("Uploading archive", {
      url: pageUrl,
      htmlBytes: htmlBlob.size,
      screenshotBytes: maybeScreenshot !== null ? maybeScreenshot.blob.size : null,
    });

    const [response, error] = await reqwest<ApiArchiveResponse>(
      createUrl(serverUrl, "/api/archive"),
      {
        method: "POST",
        body: formData,
        token,
        timeoutMs: (Number(requestTimeoutSec) || 120) * 1000,
      },
    );

    if (error) {
      return wrapErr(error);
    }

    return ok({
      response,
      warnings,
    });
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

export type ArchiveTab = Awaited<ReturnType<typeof archiveWithFeedback>>;

export async function archiveWithFeedback(
  tabId: Int,
  { toast, tags }: { toast: boolean; tags?: Vec<IdLessTag> },
) {
  try {
    const [res, error] = await archiveTab(tabId, { tags });
    if (error !== null) {
      return wrapErr(error);
    }

    if (toast) {
      const n = res.response.version;
      log.error(`Archived ✓${n ? ` (${n} version${n === 1 ? "" : "s"})` : ""}`);
      injectBanner(tabId, {
        mode: "toast",
        kind: "ok",
        text: `Archived ✓${n ? ` (${n} version${n === 1 ? "" : "s"})` : ""}`,
      });
    }
    return ok(res);
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

    return err({
      reason: "archive_failed",
      logger: log,
      detail: errorMessage,
      extra: e,
    });
  }
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

  const { serverUrl, directArchiveMode, directArchiveDelaySec, defaultTags, token } =
    await getExtensionSettings();
  const [_, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return wrapErr(serverUnconfigured);

  await sleep(Math.max(0, Number(directArchiveDelaySec) || 0) * 1000);

  logCapture.debug(`Direct-archive mode: ${directArchiveMode}`, { tabId });

  if (directArchiveMode === "auto") {
    // Per-URL pending tags are merged inside archiveTab automatically.
    archiveWithFeedback(tabId, { toast: true, tags: opened?.tags ?? undefined });
  } else {
    // Prompt mode: offer a tag chip row (site's current/default tags, preselected)
    // before confirming; chosen tags are sent with ARCHIVE_FROM_PAGE.
    const defaults = mergeTagNames(Vec.from(defaultTags), opened?.tags ?? []);

    const [urlToLookUp, error2] = await extractTabUrl(tabId, log);
    if (error2) return wrapErr(error2);
    const url = canonicalizeUrl(urlToLookUp);

    const [page, error] = await pageLookup(url, { serverUrl, token });
    const siteTags = error === null && page ? page.tags : [];
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
  const [response, error] = await reqwest<ApiPageDetail>(reqUrl, {
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
