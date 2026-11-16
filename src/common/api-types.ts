/**
 * Wire types for the JSON API mounted at `/api`.
 *
 * Source of truth: `src/transport/api/*.rs`, `src/db/*.rs`, `src/domain/*.rs`,
 * `src/transport/dto/*.rs`, and `src/error.rs`.
 *
 * Conventions:
 * - Ids are JSON numbers; archive timestamps are Unix seconds.
 * - Account, session, API-key and audit timestamps are RFC 3339 strings.
 * - JSON keys are snake_case throughout.
 * - Multipart field names are literal strings read by the handlers, so
 *   `POST /api/page` and `POST /api/page/:id/capture` use snake_case
 *   (`display_title`, `collection_id`, `pending_id`, `save_assets`).
 * - Multipart/query booleans accept `true`/`false`, `1`/`0`, `yes`/`no`,
 *   `on`/`off`.
 * - Every endpoint may instead return `ApiErrorBody` with a non-2xx status.
 *
 * Current implementation notes:
 * - `GET /api/tag` wraps its list in `{ "tags": ... }`.
 * - `GET /api/page/:id/capture` returns a cursor page of capture summaries.
 * - `GET /api/page` ignores the cursor for `sort=name`.
 */

// ── Primitives ──────────────────────────────────────────────────────────────

/** A database row id. */
export type Id = number;

/** Unix epoch seconds. */
export type Timestamp = number;

/** RFC 3339 timestamp used by account/admin DTOs. */
export type DateTime = string;

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

/** Successful no-content-style responses that still carry a JSON body. */
export interface OkResponse {
  ok: boolean;
}

// ── Pagination ──────────────────────────────────────────────────────────────

/** Cursors are opaque decimal strings on the wire. */
export type Cursor = string;

/** Page cursors are serialized as `"<created_at>:<id>"`. */
export type PageCursor = string;

export interface CursorPage<T, C = Cursor> {
  items: T[];
  /** `null` on the last page. */
  next_cursor: C | null;
}

// ── Tags ────────────────────────────────────────────────────────────────────

export interface Tag {
  id: Id;
  name: string;
  color: TagColor | null;
  created_at: Timestamp;
}

export interface TagSummary extends Tag {
  page_count: number;
  pending_count: number;
}

/** Body of `GET /api/tag`. */
export interface TagListResponse {
  tags: TagSummary[];
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
  owner_user_id: Id;
  name: string;
  emoji: string;
  description: string;
  color: string;
  public: boolean;
  is_builtin: boolean;
  created_at: Timestamp;
  /** Pages filed directly under this collection. */
  link_count: number;
}

export interface CollectionCreateRequest {
  name: string;
  emoji?: string | null;
  description?: string | null;
  /** CSS color, default `#6d5dfc`. */
  color?: string | null;
  /** Accepted for wire compatibility; collections are flat, so this is ignored. */
  parent_id?: string | null;
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
  last_error: string | null;
  created_at: Timestamp;
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
  /** Replaces the queued URL. */
  url?: string;
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
  last_captured_at: Timestamp;
  capture_count: number;
  /** User title, else latest capture title, else the URL. */
  display_title: string;
  description: string;
  collection_id: Id | null;
  collection_name: string | null;
  collection_emoji: string | null;
  pinned: boolean;
  thumbnail_content_id: Id | null;
  created_at: Timestamp;
  has_html: boolean;
  has_screenshot: boolean;
}

export interface PageItem extends PageRecord {
  tags: Tag[];
}

export interface PageDetail extends PageItem {
  latest_capture: CaptureSummary | null;
}

export interface ListPagesQuery {
  text?: string;
  field?: PageField;
  sort?: PageSort;
  pinned_only?: boolean;
  collection_id?: Id;
  unorganized_only?: boolean;
  tag_id?: Id;
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
  display_title: string;
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
 * Absent field = unchanged; `null` clears the field. (`tags: null` is accepted
 * but currently leaves the tag set unchanged.)
 */
export interface PatchPageRequest {
  display_title?: string | null;
  description?: string | null;
  collection_id?: string | null;
  pinned?: boolean | null;
  tags?: string | null;
}

export interface AddPageTagRequest {
  name: string;
}

export interface PageTagName {
  name: string;
}

export interface ReplaceTagsRequest {
  tags: PageTagName[];
}

// ── Captures / archive ──────────────────────────────────────────────────────

export interface CaptureSummary {
  id: Id;
  /** 1 = oldest; recomputed on every list. */
  version: number;
  captured_at: Timestamp;
  title: string | null;
  status_code: number | null;
  content_hash: HexHash | null;
  has_screenshot: boolean;
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
  size_original: number;
  size_stored: number;
  mime_type: MimeType;
}

export interface CaptureDetailResponse {
  id: Id;
  page_id: Id;
  url: string;
  version: number;
  captured_at: Timestamp;
  title: string | null;
  status_code: number | null;
  content_type: string | null;
  original_encoding: string | null;
  redirect_url: string | null;
  error: string | null;
  request_headers: JsonValue | null;
  response_headers: JsonValue | null;
  metadata: JsonValue | null;
  html: BlobSummary | null;
  original_html: BlobSummary | null;
  screenshot: BlobSummary | null;
  asset_count: number;
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
  content_id: Id;
  url: string;
  kind: AssetKind;
  status_code: number | null;
  hash: HexHash;
  mime_type: MimeType;
  size_original: number;
  size_stored: number;
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
  pending_id?: Id;
  /** Defaults to `false`. */
  save_assets?: MultipartBoolean;
}

export interface ArchiveDeduplication {
  /** The served (rewritten) HTML blob already existed. */
  html: boolean;
  /** The exact uploaded HTML blob already existed. */
  original_html: boolean;
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
  capture_id: Id;
  page_id: Id;
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
  content_items: number;
  assets: number;
  tags: number;
  pendings: number;
  /** Bytes actually on disk (compressed, deduplicated). */
  stored_bytes: number;
  /** Uncompressed size of unique content. */
  unique_original_bytes: number;
  /** Size without deduplication or compression. */
  logical_bytes: number;
  saved_bytes: number;
  queue: {
    queued: number;
    in_progress: number;
    failed: number;
    [status: string]: number;
  };
}

export interface GCStat {
  rows_deleted: number;
  files_deleted: number;
  tmp_removed: number;
}

// ── Auth ────────────────────────────────────────────────────────────────────

export type AccountStatus = "pending" | "active" | "suspended" | "deactivated";

export interface RegisterRequest {
  email: string;
  username?: string | null;
  password: string;
  display_name?: string | null;
}

export interface RegisterResponse {
  message: string;
}

export interface TokenRequest {
  token: string;
}

export interface LoginRequest {
  /** E-mail or username. */
  identifier: string;
  password: string;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface ForgotPasswordResponse {
  ok: boolean;
  message: string;
}

export interface ResetPasswordRequest {
  token: string;
  new_password: string;
}

// ── Account (me) ────────────────────────────────────────────────────────────

export interface UserDto {
  public_id: string;
  email: string | null;
  email_verified_at: DateTime | null;
  username: string | null;
  phone_e164: string | null;
  status: AccountStatus;
  last_login_at: DateTime | null;
  created_at: DateTime;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  locale: string | null;
  timezone: string | null;
  roles: string[];
}

export interface ProfileDto {
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  birth_date: string | null;
  locale: string;
  timezone: string;
  updated_at: DateTime;
}

export interface MeResponse {
  user: UserDto;
  profile: ProfileDto;
}

export interface UpdateProfileRequest {
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  bio?: string | null;
  /** `YYYY-MM-DD`. */
  birth_date?: string | null;
  locale?: string | null;
  timezone?: string | null;
}

export interface SessionDto {
  public_id: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: DateTime;
  last_used_at: DateTime | null;
  expires_at: DateTime;
  current: boolean;
}

export interface ListSessionsResponse {
  sessions: SessionDto[];
}

export interface ApiKeyDto {
  public_id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  created_at: DateTime;
  last_used_at: DateTime | null;
  expires_at: DateTime | null;
}

export interface ListApiKeysResponse {
  api_keys: ApiKeyDto[];
}

export interface CreateApiKeyRequest {
  name: string;
  scopes: string[];
  expires_in_days?: number;
}

/** The only response that ever contains the plaintext key. */
export interface CreatedApiKeyDto {
  public_id: string;
  key: string;
}

// ── Admin ───────────────────────────────────────────────────────────────────

export interface ListUsersQuery {
  q?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface ListUsersResponse {
  users: UserDto[];
}

export interface UpdateUserStatusRequest {
  status: AccountStatus;
  reason?: string | null;
}

export interface RoleDto {
  name: string;
  description: string | null;
  is_system: boolean;
  permissions: string[];
}

export interface ListRolesResponse {
  roles: RoleDto[];
}

export interface AuditQuery {
  limit?: number;
}

export interface AuditDto {
  id: Id;
  action: string;
  actor: string | null;
  target: string | null;
  details: JsonValue;
  created_at: DateTime;
}

export interface ListAuditResponse {
  entries: AuditDto[];
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

  "POST /api/auth/register": ApiRoute<RegisterRequest, RegisterResponse>;
  "POST /api/auth/verify": ApiRoute<TokenRequest, void>;
  "POST /api/auth/login": ApiRoute<LoginRequest, void>;
  "POST /api/auth/logout": ApiRoute<void, void>;
  "POST /api/auth/forgot": ApiRoute<ForgotPasswordRequest, ForgotPasswordResponse>;
  "POST /api/auth/reset": ApiRoute<ResetPasswordRequest, void>;

  "GET /api/me": ApiRoute<void, MeResponse>;
  "PUT /api/me/profile": ApiRoute<UpdateProfileRequest, OkResponse>;
  "GET /api/me/sessions": ApiRoute<void, ListSessionsResponse>;
  "DELETE /api/me/sessions/:public_id": ApiRoute<void, OkResponse>;
  "GET /api/me/api-keys": ApiRoute<void, ListApiKeysResponse>;
  "POST /api/me/api-keys": ApiRoute<CreateApiKeyRequest, CreatedApiKeyDto>;
  "DELETE /api/me/api-keys/:public_id": ApiRoute<void, OkResponse>;

  "GET /api/admin/users": ApiRoute<ListUsersQuery, ListUsersResponse>;
  "DELETE /api/admin/users/:public_id": ApiRoute<void, OkResponse>;
  "PATCH /api/admin/users/:public_id/status": ApiRoute<UpdateUserStatusRequest, OkResponse>;
  "POST /api/admin/users/:public_id/roles/:role": ApiRoute<void, OkResponse>;
  "DELETE /api/admin/users/:public_id/roles/:role": ApiRoute<void, OkResponse>;
  "GET /api/admin/roles": ApiRoute<void, ListRolesResponse>;
  "GET /api/admin/audit": ApiRoute<AuditQuery, ListAuditResponse>;

  "GET /api/tag": ApiRoute<void, TagListResponse>;
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
  "DELETE /api/page/:id/tag/:tag_id": ApiRoute<void, void>;
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
  "GET /api/capture/:id/asset/:content_id": ApiRoute<void, RawResponse>;

  "GET /api/content/:hash": ApiRoute<void, RawResponse>;
  "HEAD /api/content/:hash": ApiRoute<void, void>;

  "GET /api/stats": ApiRoute<void, Stats>;
  "POST /api/maintenance/gc": ApiRoute<void, GCStat>;
}
