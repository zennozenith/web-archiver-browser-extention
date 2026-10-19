import { createError, isNamedError, isStandardError } from "./error";
import { log as rootLog } from "./log.ts";
import type { ReqeustOptions, Result, Url } from "./types";

const log = rootLog.child("http");

export interface ApiErrorDetail {
  field?: string;
  issue: string;
}

/**
 * {
 *   "error": {
 *     "code": "VALIDATION_ERROR",
 *     "message": "One or more validation checks failed for the submitted data.",
 *     "status": 400,
 *     "details": [
 *       {
 *         "field": "serverUrl",
 *         "issue": "Server Url is empty"
 *       }
 *     ],
 *     "timestamp": "2026-10-18T09:50:00Z",
 *     "path": "/api/archive"
 *   }
 * }
 */
export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    status: number;
    details?: ApiErrorDetail[];
    timestamp?: string;
    path?: string;
  };
}

/** {
  "success": true,
  "message": "Resource deleted successfully.",
  "timestamp": "2026-10-18T09:50:00Z"
} */
export interface ApiSuccessResponse {
  success: true;
  message?: string;
  timestamp?: string;
}

// pending:"{"items":[
//
// {"url":"https://en.wikipedia.org/wiki/Web_archiving",
// "title":"Web Archiving - Wikipedia",
// "addedAt":"2026-10-16T13:27:27.003Z"},
// {"url":"https://news.ycombinator.com",
// "title":"Hacker News","addedAt":"2026-10-16T10:27:27.004Z"},
// {"url":"https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions",
// "title":"MDN WebExtensions Documentation","addedAt":"2026-10-15T15:27:27.004Z"}
// ],"total":3,"fetchedAt":1792249602948,"error":null}"
export interface ApiCheckPendingResponse {
  items: {
    id: string;
    url: Url;
    title: string;
    addedAt: number;
  }[];
  total: number;
}
export interface PendingResponseInStorage extends ApiCheckPendingResponse {
  fetchedAt: number;
  error: string;
}

export interface ApiArchiveVersionsResponse {
  archived: boolean;
  count: number;
  versions: {
    id: string;
    time: number;
    url: Url;
  }[];
  last?: number;
}

/* ---------- HTTP ---------- */
export async function request<T>(
  url: Url,
  {
    method = "GET",
    body,
    headers: orignalHeaders = {},
    token,
    timeoutMs = 30000,
  }: ReqeustOptions = {},
): Promise<Result<T, string>> {
  try {
    new URL(url);
  } catch {
    return createError({
      message: `Invalid URL: "${url}"`,
    });
  }

  const headers: Record<string, string> = { Accept: "application/json", ...orignalHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const done = log.time(`${method} ${url}`);
  log.debug(`${method} ${url} →`, {
    timeoutMs,
    body: body instanceof FormData ? "FormData" : body,
  });
  let res, text;
  try {
    res = await fetch(url, {
      method,
      body,
      headers: headers,
      signal: ctrl.signal,
      cache: "no-store",
      credentials: "omit",
    });
    text = await res.text();
  } catch (e) {
    const isAbort = isNamedError(e) && e.name === "AbortError";
    const errorMessage = isStandardError(e) ? e.message : e;

    return createError({
      message: isAbort
        ? `Request timed out after ${Math.round(timeoutMs / 1000)}s (${url})`
        : `Cannot reach server at ${url}: ${errorMessage}`,
    });
  } finally {
    clearTimeout(timer);
  }
  done(res.status);

  let data: T | null = null;
  try {
    data = JSON.parse(text) as T;
  } catch {
    return createError({
      message: `Response data in not json: ${text}`,
    });
  }

  if (!res.ok) {
    let error_data = data as null | ApiErrorResponse;
    const m = error_data && error_data.error;
    const msg = m
      ? typeof m === "string"
        ? m
        : JSON.stringify(m)
      : (text || res.statusText).slice(0, 300);

    return createError({
      message: `Server error ${res.status}: ${msg}`,
    });
  }

  return { ok: true, data };
}
