import { WebRequest } from "webextension-polyfill";
import { ApiArchiveVersionsResponse } from "./reqwest";
import { LevelSetting } from "./logger";

export type Int = number;
export type ISODateTime = string;
export type Url = string;
export type Uuid = string;

export interface OverrideUrl {
  override: boolean;
  url: Url;
}

export interface NonEmptyArray<T> extends Array<T> {
  0: T;
}

export interface Endpoint {
  server: Url;
  archive: Url;
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
  logLevel: LevelSetting;
  apiToken: string;
  autoCheck: boolean;
  archiveUrl: OverrideUrl;
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
  lang: string | null; //  eg: "en-US"
  charset: string; //      eg: "UTF-8",
  contentType: string; //  eg: "text/html",
  lastModified: string; // eg: "09/04/2026 17:47:04"
  canonical: string | null;

  favicon: any;
  meta: Record<string, string | null>;
  viewport: {
    width: number; //      eg: 1080
    height: number; //     eg: 1902
    dpr: number; //        eg: 1
  };
  scrollWidth: number; //  eg: 1902
  scrollHeight: number; // eg: 23608
  userAgent: string; //    eg: "Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0",
  language: string;
}

export interface BannerOpts {
  kind: "ok" | "err" | (string & {});
  text: string;
  mode: "prompt" | "toast" | (string & {});
}

export interface ArchiveErrorStatus {
  state: "error" | "unsupported" | "unconfigured";
  url: Url;
  error: string;
  checkedAt: number;
}

export interface ArchiveOkStatus extends ApiArchiveVersionsResponse {
  state: "ok";
  url: Url;
  checkedAt: number;
}

export type ArchiveStatus = ArchiveOkStatus | ArchiveErrorStatus;

export interface Configured {
  server: boolean;
  archive: boolean;
  pending: boolean;
  check: boolean;
  pendingLimit: number;
  logLevel: LevelSetting;
}

export interface ApiSuccessArchiveResponse {
  success: true;
  message: string;
  id: Uuid;
  url: Url;
  archivedAt: ISODateTime;
  versionCount: number;
}

// export interface State {
//   ok: true;
//   configured: {
//     server: boolean;
//     archive: boolean;
//     pending: boolean;
//     check: boolean;
//   };
//   status: Status | null;
//   archiveError: { message: string; time: number } | null;
//   pending: PendingResponseInStorage;
//   pendingLimit: number;
// }
