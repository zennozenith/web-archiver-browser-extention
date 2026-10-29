import { err, isNamedError, isStandardError, ok } from "@common/error";
import { log as rootLog } from "@common/log";
import type { ReqeustOptions } from "@common/types";

const log = rootLog.child("http");

export interface TestEndpointResponse {
  ok: boolean;
  text: string;
}

// export interface ApiErrorDetail {
//   field?: string;
//   issue: string;
// }

// export interface ApiErrorResponse {
//   error: {
//     code: string;
//     detail: string;
//     status: number;
//     details?: ApiErrorDetail[];
//     timestamp?: string;
//     path?: string;
//   };
// }

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown> | unknown[];
  };
}

export async function reqwest<T>(
  url: URL,
  {
    method = "GET",
    body,
    headers: orignalHeaders = {},
    token,
    timeoutMs = 30000,
  }: ReqeustOptions = {},
) {
  const headers: Record<string, string> = { Accept: "application/json", ...orignalHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const done = log.time(`${method} ${url}`);
  log.debug(`${method} ${url} →`, {
    timeoutMs,
    body: body instanceof FormData ? "FormData" : body,
  });
  let res: Response, text: string;
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

    return err({
      reason: "reqwest_generic",
      detail: isAbort
        ? `Request timed out after ${Math.round(timeoutMs / 1000)}s (${url})`
        : `Cannot reach server at ${url}: ${String(errorMessage)}`,
    });
  } finally {
    clearTimeout(timer);
  }
  done(res.status);

  let data: unknown = null;
  let parsedJson = false;
  try {
    data = JSON.parse(text) as unknown;
    parsedJson = true;
  } catch {
    // Not JSON. For error responses the status line is still useful below.
  }

  if (res.ok && isApiErrorResponse(data)) {
    return err({
      reason: "reqwest_response_parse",
      detail: `${data.error.code}: ${data.error.message}`,
    });
  }

  if (!res.ok) {
    // try to interpret body as ApiErrorResponse
    const apiErr = parseApiError(data);
    const msg = apiErr
      ? `${apiErr.error.message} (${apiErr.error.code})`
      : (text || res.statusText || "empty response").slice(0, 300);

    if (apiErr) {
      return err({
        reason: "reqwest_api_error",
        detail: `Server error ${res.status}: ${msg}`,
        extra: apiErr,
      });
    }

    return err({
      reason: "reqwest_response_parse",
      detail: `Server error ${res.status}: ${msg}`,
    });
  }

  if (!parsedJson) {
    return err({
      reason: "reqwest_response_not_json",
      detail: `Response data is not json: ${text.slice(0, 300)}`,
    });
  }

  return ok(data as T);
}

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isApiErrorResponse(v: unknown): v is ApiErrorResponse {
  if (!isJsonObject(v)) return false;
  const e = v["error"];
  if (!isJsonObject(e)) return false;
  if (typeof e["code"] !== "string") return false;
  if (typeof e["message"] !== "string") return false;
  const d = e["details"];
  if (d !== undefined && !(isJsonObject(d) || Array.isArray(d))) return false;
  return true;
}

function parseApiError(data: unknown): ApiErrorResponse | null {
  return isApiErrorResponse(data) ? data : null;
}
