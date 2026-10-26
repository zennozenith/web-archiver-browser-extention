export type Int = number;
export type Int64 = number;
export type UInt64 = number;
export type ISODateTime = string;
export type Url = string;
export type Uuid = string;

export type Vec<T> = Array<T>;
export const Vec = Array;

export interface OverrideUrl {
  override: boolean;
  url: Url;
}

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

export type WithNullish<T> = T | null | undefined;

export interface Page<T> {
  items: Vec<T>;
  next_cursor: Option<string>;
}
