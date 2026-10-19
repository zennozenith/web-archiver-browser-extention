import type { Logger } from "./logger.ts";
import { log as genericLog } from "./log.ts";
import { NonEmptyArray } from "./types.ts";

export interface Ok<T> {
  ok: true;
  data: T;
}

export interface Err {
  ok: false;
  messages: NonEmptyArray<string>;
  extra: Array<unknown>;
}

export type Result<T> = Ok<T> | Err;

export function createError({
  log = genericLog,
  error,
  message,
  extra: _extra,
}: {
  log?: Logger;
  error?: Err;
  message: string;
  extra?: unknown;
}): Err {
  log.error(message, _extra);
  const extra: any[] = [];
  if (_extra !== null || _extra !== undefined) {
    extra.push(_extra);
  }

  if (error) {
    return {
      ok: false,
      messages: [message, ...error.messages],
      extra: [...extra, ...error.extra],
    };
  }

  return {
    ok: false,
    messages: [message],
    extra,
  };
}

export function createOk<T>(data: T): Ok<T> {
  return {
    ok: true,
    data,
  };
}

interface NamedError {
  name: string;
}

interface StandardError {
  message: string;
}

// 2. Create type guard functions
export function isNamedError(err: unknown): err is NamedError {
  return typeof err === "object" && err !== null && "name" in err;
}

export function isStandardError(err: unknown): err is StandardError {
  return typeof err === "object" && err !== null && "message" in err;
}
