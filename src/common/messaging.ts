import browser from "webextension-polyfill";
import type { ArchiveStatus, Configured, Int, Url } from "./types.ts";
import { log as rootLog } from "./log.ts";
import { Result } from "./error.ts";
import { ApiSuccessArchiveResponse, PendingResponseInStorage } from "./reqwest.ts";

const log = rootLog.child("messaging");

export type Empty = Record<string, never>;

/**
 * Single source of truth: each message type maps to its payload and the data
 * a successful response carries.
 */
export interface MessageMap {
  GET_CONFIGURED: { payload: undefined; data: Configured };
  GET_ARCHIVE: { payload: { tabId: Int }; data: ArchiveStatus };
  GET_PENDING: { payload: undefined; data: PendingResponseInStorage };
  ARCHIVE_TAB: {
    payload: { tabId: Int };
    data: {
      response: ApiSuccessArchiveResponse;
      warnings: string[];
    };
  };
  REFRESH_PENDING: { payload: undefined; data: { ok: boolean } };
  OPEN_AND_ARCHIVE: { payload: { url: Url }; data: void };
  ARCHIVE_FROM_PAGE: {
    payload: undefined;
    data: ArchiveStatus;
  };
}

export type MessageType = keyof MessageMap;
export type MessagePayload<T extends MessageType> = MessageMap[T]["payload"];
export type MessageData<T extends MessageType> = MessageMap[T]["data"];

/** Discriminated union of every possible message (narrows on `type`). */
export type Message<T extends MessageType = MessageType> = {
  [K in T]: { type: K; payload: MessagePayload<K> };
}[T];

/** Payload is optional only for messages whose payload is `undefined`. */
type PayloadArgs<T extends MessageType> =
  MessagePayload<T> extends undefined ? [payload?: undefined] : [payload: MessagePayload<T>];

/**
 * Sends a strongly-typed message to the background service worker/script.
 * `T` is inferred from `type`, so payload and return type are both checked.
 */
export async function sendToBackground<T extends MessageType>(
  type: T,
  ...args: PayloadArgs<T>
): Promise<Result<MessageData<T>>> {
  const message = { type, payload: args[0] } as Message<T>;
  log.debug(`message:${type} →`, args[0]);
  try {
    const response: unknown = await browser.runtime.sendMessage(message);
    if (!isMessageResponse<MessageData<T>>(response)) {
      log.error(`message:${type} No/invalid response received`, response);
      return { ok: false, messages: ["No response received"], extra: [] };
    }
    log.debug(`message:${type} ← ok`);
    return response;
  } catch (err) {
    log.error(`message:${type} send failed`, err);
    return {
      ok: false,
      messages: [err instanceof Error ? err.message : String(err)],
      extra: [err instanceof Error ? err : {}],
    };
  }
}

function isMessageResponse<D>(value: unknown): value is Result<D> {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  const v = value as { ok: unknown; messages?: unknown; extra?: unknown };

  return (
    v.ok === true ||
    (v.ok === false &&
      Array.isArray(v.extra) &&
      Array.isArray(v.messages) &&
      v.messages.length > 0 &&
      v.messages.every((el): el is string => typeof el === "string"))
  );
}
