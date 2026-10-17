export type Int = number;
export type Url = string;

export type MessageType =
  | "ARCHIVE_TAB"
  | "CHECK_TAB"
  | "CHECK_TAB"
  | "GET_STATE"
  | "ARCHIVE_FROM_PAGE"
  | "REFRESH_PENDING"
  | "OPEN_AND_ARCHIVE"
  | "CLEAR_ARCHIVE_ERROR";

export interface BaseMessage<T = unknown> {
  type: MessageType;
  payload?: T;
}

export interface ErrorWithMessage {
  message: string;
}

export interface DerivedEndpoint {
  derived: {
    archive: Url;
    pending: Url;
    check: Url;
  };
  source: {
    archive: "none" | "override" | "derived";
    pending: "none" | "override" | "derived";
    check: "none" | "override" | "derived";
  };
  archive: Url;
  pending: Url;
  check: Url;
}

export interface ArchiveTabPayload {
  tabId: Int;
}

export interface HeaderItem {
  name: string;
  value?: string;
}

export interface HeadersWithMeta {
  requestHeaders: HeaderItem[];
  responseHeaders: HeaderItem[];
  url: Url;
  method: string;
  statusCode: number;
  time: number;
  statusLine: string;
}

export interface ReqeustOptions {
  method?: "GET" | "POST";
  body?: BodyInit;
  headers?: Record<string, string>;
  token?: string;
  timeoutMs?: Int;
}

export interface MessageResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface ExtensionSettings {
  apiToken: string;
  archiveUrl: Url;
  autoCheck: boolean;
  checkUrl: Url;
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
  pendingUrl: Url;
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

export interface Pending {
  items: {
    url: Url;
    title: string;
    addedAt: string;
  }[];
  total: number;
  fetchedAt: number;
  error: string | null;
}

export interface CheckUrlResponse {
  archived: boolean;
  count: number;
  versions: {
    id: string;
    time: string;
    url: Url;
  }[];
  last?: string | null;
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

export interface OkStatus extends CheckUrlResponse {
  state: "ok";
  url: Url;
  checkedAt: number;
}

export type Status = UnsupportedStatus | UnconfiguredStatus | ErrorStatus | OkStatus;

// export interface Status {
//   state: "unsupported" | "unconfigured" | "error";
//   archived: boolean;
//   url: Url;
//   count: Int;
//   versions: any[];
//   last: unknown;
//   error?: string;
// }
