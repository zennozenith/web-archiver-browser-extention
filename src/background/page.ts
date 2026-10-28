import { err, Fail, ok, Ok, wrapErr } from "@common/error";
import { bgRootlog } from "@common/log";
import { ApiErrorResponse, reqwest } from "./reqwest";
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

const inflight = new Map<
  string,
  Promise<
    | Ok<readonly [ApiPageDetail, Page<ApiCaptureSummary>]>
    | Fail<
        | Omit<
            {
              reason: "reqwest_generic";
              detail: string;
            },
            "logger"
          >
        | Omit<
            {
              reason: "reqwest_response_not_json";
              detail: string;
            },
            "logger"
          >
        | Omit<
            {
              reason: "reqwest_api_error";
              detail: string;
              extra: ApiErrorResponse;
            },
            "logger"
          >
        | Omit<
            {
              reason: "reqwest_response_parse";
              detail: string;
            },
            "logger"
          >
        | {
            reason: "not_found";
            detail: string;
            extra: ApiErrorResponse;
          }
      >
  >
>();

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

export async function pageLookupFull(tabId: Int) {
  const { serverUrl, token } = await getExtensionSettings();
  const [_, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return wrapErr(serverUnconfigured);

  const [urlToLookUp, error] = await extractTabUrl(tabId, log);
  if (error) return wrapErr(error);

  const url = canonicalizeUrl(urlToLookUp);
  const urlShaHash = await sha256(url);

  const key = urlShaHash;

  if (inflight.has(key)) {
    log.debug("Joining in-flight page check", { url: url });
    await inflight.get(key)!;
  }

  const inflightStatusPromise = (async () => {
    const [page, error1] = await pageLookup(url, { serverUrl, token });
    if (error1) {
      return wrapErr(error1);
    }

    let versions: Page<ApiCaptureSummary> | null = null;
    if (page.captureCount === 1) {
      versions = { items: [page.latestCapture], nextCursor: null };
    } else {
      const [_versions, error2] = await pageVersions(page.id, { serverUrl, token });
      if (error2) {
        return wrapErr(error2);
      }
      versions = _versions;
    }

    let out = ok([page, versions] as const);
    await session_storage_set(`status:${urlShaHash}`, out);

    return out;
  })().finally(() => inflight.delete(key));

  inflight.set(key, inflightStatusPromise);
  return inflightStatusPromise;
}
