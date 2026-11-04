/**
 * Wire types for the JSON API mounted at `/api`.
 *
 * Source of truth: `src/api/*.rs`, `src/db/*.rs`, `src/tag.rs`, `src/error.rs`.
 *
 * Conventions:
 * - Ids are JSON numbers, timestamps are Unix seconds.
 * - JSON keys are camelCase throughout (every serde struct uses `rename_all`).
 *   Enum values keep their explicit spellings (e.g. `PendingStatus` uses
 *   `"in_progress"`).
 * - Multipart field names are literal strings read by the handlers, so
 *   `POST /api/page` and `POST /api/page/:id/capture` uses camelCase
 *   (`displayTitle`, `collectionId`, `pendingId`, `saveAssets`).
 * - Multipart/query booleans accept `true`/`false`, `1`/`0`, `yes`/`no`,
 *   `on`/`off`.
 * - Every endpoint may instead return `ApiErrorBody` with a non-2xx status.
 *
 * Current implementation notes:
 * - `GET /api/page/:id/capture` returns a cursor page of capture summaries.
 */

// ── Primitives ──────────────────────────────────────────────────────────────

/** A database row id. */
export type Id = number;

/** Unix epoch seconds. */
export type Timestamp = number;

/** Lowercase, 64-character hex-encoded BLAKE3 hash. */
export type HexHash = string;

/** Normalized `type/subtype` media type, e.g. `text/html`. */
export type MimeType = string;

/** Palette key such as `"red"` or `"deep-blue"`; never a hex color. */
export type TagColor = string;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Raw bytes response (HTML, screenshot, asset, content blob). */
export type RawResponse = Blob;

/** Multipart/query-string booleans are parsed leniently by the server. */
export type MultipartBoolean = boolean | "true" | "false" | "1" | "0" | "yes" | "no" | "on" | "off";

// ── Errors ──────────────────────────────────────────────────────────────────

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: JsonValue;
  };
}

// ── Pagination ──────────────────────────────────────────────────────────────

/** Cursors are opaque decimal strings on the wire. */
export type Cursor = string;

/** Page cursors are serialized as `"<captured_at>:<id>"`. */
export type PageCursor = string;

export interface CursorPage<T, C = Cursor> {
  items: T[];
  /** `null` on the last page. */
  nextCursor: C | null;
}

// ── Tags ────────────────────────────────────────────────────────────────────

export interface Tag {
  id: Id;
  name: string;
  color: TagColor | null;
  createdAt: Timestamp;
}

export interface TagSummary extends Tag {
  pageCount: number;
  pendingCount: number;
}

export interface CreateTagRequest {
  name: string;
  color?: TagColor | null;
}

/** Absent field = unchanged; `color: null` (or `""`) clears the color. */
export interface PatchTagRequest {
  name?: string;
  color?: TagColor | null;
}

export interface MergeTagRequest {
  /** The surviving tag. */
  into: Id;
}

// ── Collections ─────────────────────────────────────────────────────────────

export interface CollectionRecord {
  id: Id;
  name: string;
  emoji: string;
  description: string;
  color: string;
  parentId: Id | null;
  public: boolean;
  /** Pages filed directly under this collection. */
  linkCount: number;
}

export interface CollectionCreateRequest {
  name: string;
  description?: string | null;
  /** Numeric id as a string; invalid/empty values become `null`. */
  parentId?: string | null;
  /** CSS color, default `#6d5dfc`. */
  color?: string | null;
}

/** Same body is accepted by both POST and PUT on `/collection/:id`. */
export type CollectionUpdateRequest = CollectionCreateRequest;

export interface UpdateSharingRequest {
  public?: boolean;
}

// ── Pending queue ───────────────────────────────────────────────────────────

export type PendingStatus = "queued" | "in_progress" | "failed";

export interface PendingRecord {
  id: Id;
  url: string;
  status: PendingStatus;
  attempts: number;
  lastError: string | null;
  createdAt: Timestamp;
}

export interface PendingItem extends PendingRecord {
  tags: Tag[];
}

/** Either comma-separated (`"a,b"`) or an array (`["a", "b"]`). */
export type TagNamesInput = string | string[];

export interface CreatePendingRequest {
  url: string;
  tags?: TagNamesInput;
}

export interface PatchPendingRequest {
  /** Replaces the whole tag set when present. */
  tags?: TagNamesInput;
  /** `in_progress` is rejected; use `POST /api/pending/claim` instead. */
  status?: PendingStatus;
}

export interface FailPendingRequest {
  error: string;
}

export interface ListPendingQuery {
  status?: PendingStatus;
  /** 1..=1000 (default 50). */
  limit?: number;
  cursor?: Cursor;
}

export interface ClearPendingQuery {
  /** `in_progress` is rejected. */
  status: PendingStatus;
}

export interface ClearPendingResponse {
  deleted: number;
}

export interface BulkCreateRequest {
  /** 1..=500 entries. One invalid item does not fail the batch. */
  items: CreatePendingRequest[];
}

export type BulkItemStatus = "created" | "duplicate" | "invalid";

export interface BulkItemResult {
  url: string;
  status: BulkItemStatus;
  /** Omitted when the item is invalid. */
  id?: Id;
  /** Present only for invalid items. */
  error?: string;
}

export interface BulkCreateResponse {
  created: number;
  duplicates: number;
  invalid: number;
  results: BulkItemResult[];
}

// ── Pages ───────────────────────────────────────────────────────────────────

export type PageSort = "newest" | "oldest" | "name";
export type PageField = "name" | "url" | "text" | "tags";

/** Flattened into `PageItem` / `PageDetail`. */
export interface PageRecord {
  id: Id;
  url: string;
  host: string;
  /** `0` when the page has no captures. */
  lastCapturedAt: Timestamp;
  captureCount: number;
  /** User title, else latest capture title, else the URL. */
  displayTitle: string;
  description: string;
  collectionId: Id | null;
  collectionName: string | null;
  collectionEmoji: string | null;
  pinned: boolean;
  thumbnailContentId: Id | null;
  createdAt: Timestamp;
  hasHtml: boolean;
  hasScreenshot: boolean;
}

export interface PageItem extends PageRecord {
  tags: Tag[];
}

export interface PageDetail extends PageItem {
  latestCapture: CaptureSummary | null;
}

export interface ListPagesQuery {
  text?: string;
  field?: PageField;
  sort?: PageSort;
  pinnedOnly?: boolean;
  collectionId?: Id;
  tagId?: Id;
  /** 1..=1000 (default 50). */
  limit?: number;
  cursor?: PageCursor;
}

export interface LookupPageQuery {
  url: string;
}

/**
 * Multipart fields for `POST /api/page`. These are literal multipart field
 * names (`display_title` is required); `tags` is comma-separated, not a JSON
 * array.
 */
export interface CreatePageRequest {
  url: string;
  displayTitle: string;
  description?: string;
  /** Numeric id as a string; invalid/empty values become `null`. */
  collection_id?: string;
  pinned?: MultipartBoolean;
  /** Comma-separated tag names. */
  tags?: string;
  thumbnail?: Blob;
}

/**
 * Body for `PATCH /api/page/:id`.
 * Absent field = unchanged; `null` is the shared "clear" variant; `tags` is
 * comma-separated. (The handler currently leaves tags unchanged on `null`.)
 */
export interface PatchPageRequest {
  displayTitle?: string | null;
  description?: string | null;
  collectionId?: string | null;
  pinned?: boolean | null;
  tags?: string | null;
}

export interface AddPageTagRequest {
  name: string;
}

export interface ReplaceTagsRequest {
  tags: CreateTagRequest[];
}

// ── Captures / archive ──────────────────────────────────────────────────────

export interface CaptureSummary {
  id: Id;
  /** 1 = oldest; recomputed on every list. */
  version: number;
  capturedAt: Timestamp;
  title: string | null;
  statusCode: number | null;
  contentHash: HexHash | null;
  hasScreenshot: boolean;
}

/** Query for the page's capture history. Cursor is the last seen version. */
export interface ListCapturesQuery {
  /** 1..=1000 (default 50). */
  limit?: number;
  cursor?: Cursor;
}

/** `GET /api/page/:id/capture`, newest version first. */
export type CaptureHistoryResponse = CursorPage<CaptureSummary>;

export interface BlobSummary {
  hash: HexHash;
  sizeOriginal: number;
  sizeStored: number;
  mimeType: MimeType;
}

export interface CaptureDetailResponse {
  id: Id;
  pageId: Id;
  url: string;
  version: number;
  capturedAt: Timestamp;
  title: string | null;
  statusCode: number | null;
  contentType: string | null;
  originalEncoding: string | null;
  redirectUrl: string | null;
  error: string | null;
  requestHeaders: JsonValue | null;
  responseHeaders: JsonValue | null;
  metadata: JsonValue | null;
  html: BlobSummary | null;
  originalHtml: BlobSummary | null;
  screenshot: BlobSummary | null;
  assetCount: number;
}

export type AssetKind =
  | "stylesheet"
  | "script"
  | "image"
  | "font"
  | "media"
  | "frame"
  | "manifest"
  | "icon"
  | "other";

export interface CaptureAsset {
  contentId: Id;
  url: string;
  kind: AssetKind;
  statusCode: number | null;
  hash: HexHash;
  mimeType: MimeType;
  sizeOriginal: number;
  sizeStored: number;
}

/**
 * Multipart fields for `POST /api/page/:id/capture`.
 * Build a `FormData` from this; `metadata` must be JSON-encoded, and boolean
 * fields may be sent as `"true"`/`"false"` (or the other accepted spellings).
 */
export interface ArchiveCaptureRequest {
  /** Required, must not be empty. */
  html: Blob;
  /** Format is detected from the bytes (png/jpeg/webp/...). */
  screenshot?: Blob;
  /** JSON-encoded object; `title` may also be read from it. */
  metadata?: string | { [key: string]: JsonValue };
  title?: string;
  /** Dequeues the matching pending item after a successful archive. */
  pendingId?: Id;
  /** Defaults to `false`.*/
  saveAssets?: MultipartBoolean;
}

export interface ArchiveDeduplication {
  /** The served (rewritten) HTML blob already existed. */
  html: boolean;
  /** The exact uploaded HTML blob already existed. */
  originalHtml: boolean;
  /** `null` when no screenshot was uploaded. */
  screenshot: boolean | null;
}

export interface AssetSummary {
  saved: number;
  deduplicated: number;
  failed: number;
  skipped: number;
}

export interface ArchiveResponse {
  captureId: Id;
  pageId: Id;
  version: number;
  deduplicated: ArchiveDeduplication;
  assets: AssetSummary;
}

// ── Stats / maintenance ─────────────────────────────────────────────────────

export interface HealthResponse {
  status: "ok";
}

export interface Stats {
  pages: number;
  captures: number;
  contentItems: number;
  assets: number;
  tags: number;
  pendings: number;
  /** Bytes actually on disk (compressed, deduplicated). */
  storedBytes: number;
  /** Uncompressed size of unique content. */
  uniqueOriginalBytes: number;
  /** Size without deduplication or compression. */
  logicalBytes: number;
  savedBytes: number;
  queue: {
    queued: number;
    in_progress: number;
    failed: number;
    [status: string]: number;
  };
}

export interface GCStat {
  rowsDeleted: number;
  filesDeleted: number;
  tmpRemoved: number;
}

// ── Route map ───────────────────────────────────────────────────────────────

export interface ApiRoute<Req, Res> {
  request: Req;
  response: Res;
}

/**
 * Request/response types keyed by method and path. `void` requests take only
 * path/query params; `void` responses are empty (`204`) or redirects (`307`).
 * Every route can also produce `ApiErrorBody`.
 */
export interface ApiRoutes {
  "GET /api/health": ApiRoute<void, HealthResponse>;

  "GET /api/tag": ApiRoute<void, TagSummary[]>;
  "POST /api/tag": ApiRoute<CreateTagRequest, Tag>;
  "PATCH /api/tag/:id": ApiRoute<PatchTagRequest, Tag>;
  "DELETE /api/tag/:id": ApiRoute<void, void>;
  "POST /api/tag/:id/merge": ApiRoute<MergeTagRequest, Tag>;

  "GET /api/collection": ApiRoute<void, CollectionRecord[]>;
  "POST /api/collection": ApiRoute<CollectionCreateRequest, CollectionRecord>;
  "GET /api/collection/:id": ApiRoute<void, CollectionRecord>;
  "POST /api/collection/:id": ApiRoute<CollectionUpdateRequest, CollectionRecord>;
  "PUT /api/collection/:id": ApiRoute<CollectionUpdateRequest, CollectionRecord>;
  "DELETE /api/collection/:id": ApiRoute<void, void>;
  "PUT /api/collection/:id/sharing": ApiRoute<UpdateSharingRequest, void>;
  "GET /api/public/collection/:id": ApiRoute<void, CollectionRecord>;

  "GET /api/pending": ApiRoute<ListPendingQuery, CursorPage<PendingItem>>;
  "POST /api/pending": ApiRoute<CreatePendingRequest, PendingItem>;
  "DELETE /api/pending": ApiRoute<ClearPendingQuery, ClearPendingResponse>;
  "POST /api/pending/bulk": ApiRoute<BulkCreateRequest, BulkCreateResponse>;
  /** `204` when the queue is empty. */
  "POST /api/pending/claim": ApiRoute<void, PendingItem | void>;
  "GET /api/pending/:id": ApiRoute<void, PendingItem>;
  "PATCH /api/pending/:id": ApiRoute<PatchPendingRequest, PendingItem>;
  "DELETE /api/pending/:id": ApiRoute<void, void>;
  "POST /api/pending/:id/retry": ApiRoute<void, PendingItem>;
  "POST /api/pending/:id/fail": ApiRoute<FailPendingRequest, PendingItem>;

  "GET /api/page": ApiRoute<ListPagesQuery, CursorPage<PageItem, PageCursor>>;
  "POST /api/page": ApiRoute<CreatePageRequest, PageItem>;
  "GET /api/page/lookup": ApiRoute<LookupPageQuery, PageDetail>;
  "GET /api/page/:id": ApiRoute<void, PageDetail>;
  "PATCH /api/page/:id": ApiRoute<PatchPageRequest, void>;
  "DELETE /api/page/:id": ApiRoute<void, void>;
  "GET /api/page/:id/thumbnail": ApiRoute<void, RawResponse>;
  "GET /api/page/:id/capture": ApiRoute<ListCapturesQuery, CaptureHistoryResponse>;
  "POST /api/page/:id/capture": ApiRoute<ArchiveCaptureRequest, ArchiveResponse>;
  "POST /api/page/:id/tag": ApiRoute<AddPageTagRequest, Tag>;
  "PUT /api/page/:id/tag": ApiRoute<ReplaceTagsRequest, Tag[]>;
  "DELETE /api/page/:id/tag/:tagId": ApiRoute<void, void>;
  /** `307` redirect to the latest capture's HTML. */
  "GET /api/page/:id/latest/html": ApiRoute<void, void>;
  /** `307` redirect to the latest capture's original HTML. */
  "GET /api/page/:id/latest/html/original": ApiRoute<void, void>;
  /** `307` redirect to the latest capture's screenshot. */
  "GET /api/page/:id/latest/screenshot": ApiRoute<void, void>;
  "GET /api/page/:id/latest/asset": ApiRoute<void, CaptureAsset[]>;

  "GET /api/capture/:id": ApiRoute<void, CaptureDetailResponse>;
  "DELETE /api/capture/:id": ApiRoute<void, void>;
  "GET /api/capture/:id/html": ApiRoute<void, RawResponse>;
  "GET /api/capture/:id/html/original": ApiRoute<void, RawResponse>;
  "GET /api/capture/:id/screenshot": ApiRoute<void, RawResponse>;
  "GET /api/capture/:id/asset": ApiRoute<void, CaptureAsset[]>;
  "GET /api/capture/:id/asset/:contentId": ApiRoute<void, RawResponse>;

  "GET /api/content/:hash": ApiRoute<void, RawResponse>;
  "HEAD /api/content/:hash": ApiRoute<void, void>;

  "GET /api/stats": ApiRoute<void, Stats>;
  "POST /api/maintenance/gc": ApiRoute<void, GCStat>;
}
