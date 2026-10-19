export type Int = number;
export type ISODateTime = string;
export type Url = string;
export type Uuid = string;

export interface NonEmptyArray<T> extends Array<T> {
  0: T;
}

export interface ApiArchiveVersionsResponse {
  archived: boolean;
  count: number;
  versions: {
    id: string;
    archivedAt: ISODateTime;
    url: Url;
    title: string;
    htmlSize: number;
    hasScreenshot: boolean;
  }[];
  lastArchivedAt?: ISODateTime;
}

export interface PendingResponseInStorage extends ApiCheckPendingResponse {
  fetchedAt: number;
  error: string;
}

export interface ApiCheckPendingResponse {
  items: {
    id: string;
    url: Url;
    title: string;
    addedAt: ISODateTime;
  }[];
  total: number;
}

interface UnsupportedStatus {
  state: "unsupported";
  url: Url;
  checkedAt: number;
}

interface UnconfiguredStatus {
  state: "unconfigured";
  url: Url;
  checkedAt: number;
}

interface ErrorStatus {
  state: "error";
  url: Url;
  error: string;
  checkedAt: number;
}

export interface ArchiveOkStatus extends ApiArchiveVersionsResponse {
  state: "ok";
  url: Url;
  checkedAt: number;
}

export type ArchiveStatus = UnsupportedStatus | UnconfiguredStatus | ErrorStatus | ArchiveOkStatus;

export interface Configured {
  server: boolean;
  archive: boolean;
  pending: boolean;
  check: boolean;
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
//   status: Status | null;
//   archiveError: { message: string; time: number } | null;
//   pending: PendingResponseInStorage;
//   pendingLimit: number;
// }
