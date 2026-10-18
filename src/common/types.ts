import { WebRequest } from "webextension-polyfill";
import { ApiArchiveVersionsResponse, PendingResponseInStorage } from "./reqwest";

export type Int = number;
export type Url = string;

export interface OverrideUrl {
  override: boolean;
  url: Url;
}

export type ErrorType = "generic" | (string & {});

export interface CustomError<T = unknown> {
  type: string;
  message: string;
  extra?: T;
}

export interface Ok<T> {
  ok: true;
  data: T;
}

export interface Err<E> {
  ok: false;
  error: CustomError<E>;
}

export type Result<T, E = unknown> = Ok<T> | Err<E>;

export interface Endpoint {
  server: Url;
  pending: Url;
  check: Url;
}

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

export interface ReqeustOptions {
  method?: "GET" | "POST";
  body?: BodyInit;
  headers?: Record<string, string>;
  token?: string;
  timeoutMs?: Int;
}

export interface ExtensionSettings {
  apiToken: string;
  autoCheck: boolean;
  checkUrl: OverrideUrl;
  directArchiveDelaySec: Int;
  directArchiveMode: "prompt" | "auto";
  fullPageScreenshot: boolean; // Firefox only
  includeRequestHeaders: boolean;
  includeResponseHeaders: boolean;
  includeScreenshot: boolean;
  includeSensitiveHeaders: boolean;
  jpegQuality: Int;
  pendingLimit: Int;
  pendingRefreshMinutes: Int; // 0 = off
  pendingUrl: OverrideUrl;
  requestTimeoutSec: Int;
  screenshotFormat: "png" | "jpeg";
  serverUrl: Url;
  showBadge: boolean;
  theme: "auto" | "light" | "dark";
}

export interface Page {
  html: string;
  url: string;
  title: string;
  referrer: string;
  lang: string | null;
  charset: string;
  contentType: string;
  lastModified: string;
  canonical: any;
  favicon: any;
  meta: Record<string, string | null>;
  viewport: {
    width: number;
    height: number;
    dpr: number;
  };
  scrollWidth: number;
  scrollHeight: number;
  userAgent: string;
  language: string;
}

export interface BannerOpts {
  kind: "ok" | "err" | (string & {});
  text: string;
  mode: "prompt" | "toast" | (string & {});
}

export interface UnsupportedStatus {
  state: "unsupported";
  url: Url;
}

export interface UnconfiguredStatus {
  state: "unconfigured";
  url: Url;
}

export interface ErrorStatus {
  state: "error";
  url: Url;
  error: string;
  checkedAt: number;
}

export interface OkStatus extends ApiArchiveVersionsResponse {
  state: "ok";
  url: Url;
  checkedAt: number;
}

export type Status = UnsupportedStatus | UnconfiguredStatus | ErrorStatus | OkStatus;

export interface State {
  ok: true;
  configured: {
    server: boolean;
    pending: boolean;
    check: boolean;
  };
  status: Status | null;
  archiveError: { message: string; time: number } | null;
  pending: PendingResponseInStorage;
  pendingLimit: number;
}
// export interface Status {
//   state: "unsupported" | "unconfigured" | "error";
//   archived: boolean;
//   url: Url;
//   count: Int;
//   versions: any[];
//   last: unknown;
//   error?: string;
// }
