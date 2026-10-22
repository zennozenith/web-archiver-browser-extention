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

export interface ReqeustOptions {
  method?: "GET" | "POST" | "PUT";
  body?: BodyInit;
  headers?: Record<string, string>;
  token?: string;
  timeoutMs?: Int;
}
