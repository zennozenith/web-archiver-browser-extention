import { Logger, log as genericLog } from "@common/index";
import { Err, ErrorType, Ok } from "./types";

export function createError<E = never>({
  log = genericLog,
  message,
  type = "generic",
  extra,
}: {
  log?: Logger;
  message: string;
  type?: ErrorType;
  extra?: E;
}): Err<E> {
  log.error(`[${type}] ${message}`, extra);
  return {
    ok: false,
    error: {
      type,
      message,
      extra,
    },
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
