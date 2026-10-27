import { err, isNamedError, isStandardError, ok } from "@common/error";
import { log as rootLog } from "@common/log";
import type { ReqeustOptions } from "@common/types";

const log = rootLog.child("http");

export interface TestEndpointResponse {
  ok: boolean;
  text: string;
}

export interface ApiErrorDetail {
  field?: string;
  issue: string;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    detail: string;
    status: number;
    details?: ApiErrorDetail[];
    timestamp?: string;
    path?: string;
  };
}

export async function request<T>(
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

    return err({
      reason: "reqwest_generic",
      detail: isAbort
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
    return err({
      reason: "reqwest_response_not_json",
      detail: `Response data in not json: ${text}`,
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

    return err({
      reason: "reqwest_response",
      detail: `Server error ${res.status}: ${msg}`,
    });
  }

  return ok(data);
}
