export type Int = number;
export type Int64 = number;
export type UInt64 = number;
export type ISODateTime = string;

export type Vec<T> = Array<T>;
export const Vec = Array;

export interface NonEmptyVec<T> extends Vec<T> {
  0: T;
}

export interface ReqeustOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH";
  body?: BodyInit;
  headers?: Record<string, string>;
  token?: string;
  timeoutMs?: Int;
}

export type Option<T> = T | null;

/** A tag without its server-assigned id. `color` is a palette key, never a hex value. */
export interface IdLessTag {
  name: string;
  color: Option<string>;
}

export type WithNullish<T> = T | null | undefined;

export interface Page<T> {
  items: Vec<T>;
  nextCursor: Option<string>;
  /** Total number of items on the server, when it reports one. */
  total: Option<number>;
}

/**
 * Normalize a paginated response. Servers in the wild return either a bare
 * array or `{ items, nextCursor }` / `{ items, next_cursor }`; accept all of
 * them so a casing difference does not silently drop the next page.
 */
export function toPage<T>(value: unknown): Page<T> {
  if (Array.isArray(value)) return { items: value as T[], nextCursor: null, total: null };

  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const items = Array.isArray(record["items"]) ? (record["items"] as T[]) : [];
  const cursor = record["nextCursor"] ?? record["next_cursor"] ?? record["next"] ?? null;
  const total = typeof record["total"] === "number" ? record["total"] : null;

  return {
    items,
    nextCursor: typeof cursor === "string" && cursor.length > 0 ? cursor : null,
    total,
  };
}
