import type { Logger } from "./logger.ts";
import { log as genericLogger } from "./log.ts";

export interface Err {
  reason: string;
  detail: string;
  extra?: unknown;
}

export type Result<T, E extends Err = Err> = [T, null] | [null, E];

export function ok<T>(data: T): Result<T, never> {
  return [data, null];
}

export function err<
  const R extends string,
  E extends {
    reason: R;
    detail: string;
    extra?: unknown;
    logger?: Logger;
  },
>(e: E): Result<never, E> {
  (e.logger ?? genericLogger).error(e.reason, e.detail, e.extra);

  delete e.logger;
  return [null, e];
}

export function wrapErr<
  const R extends string,
  E extends {
    reason: R;
    detail: string;
    extra?: unknown;
  },
>(e: E): Result<never, E> {
  return [null, e];
}

interface NamedError {
  name: string;
}

interface StandardError {
  message: string;
}

export function isNamedError(err: unknown): err is NamedError {
  return typeof err === "object" && err !== null && "name" in err;
}

export function isStandardError(err: unknown): err is StandardError {
  return typeof err === "object" && err !== null && "message" in err;
}
