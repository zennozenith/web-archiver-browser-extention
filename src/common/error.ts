import type { Logger } from "./logger.ts";
import { log as genericLogger } from "./log.ts";

export interface Err {
  reason: string;
  detail: string;
  extra?: unknown;
}

export type Ok<T> = [T, null];
export type Fail<E extends Err = Err> = [null, E];
export type Result<T, E extends Err = Err> = Ok<T> | Fail<E>;

export function ok<T>(data: T): Ok<T> {
  return [data, null];
}

export function err<
  const R extends string,
  E extends { reason: R; detail: string; extra?: unknown; logger?: Logger },
>(e: E): Fail<Omit<E, "logger">> {
  const { logger, ...rest } = e; // no mutation of the caller's object
  (logger ?? genericLogger).error(rest.reason, rest.detail, rest.extra);
  return [null, rest];
}

export function wrapErr<
  const R extends string,
  E extends { reason: R; detail: string; extra?: unknown },
>(e: E): Fail<E> {
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
