import browser from "webextension-polyfill";
import { Int, log, Result, State, Status, Url } from "./index.ts";

// interface BaseMessage<T = unknown> {
//   type: MessageType;
//   payload: T;
// }

// export interface ErrorMessageResponse {
//   success: false;
//   error: string;
// }

// export interface OkMessageResponse<T = unknown> {
//   success: true;
//   data: T;
// }
// export type MessageResponse<T> = OkMessageResponse<T> | ErrorMessageResponse;

// export type Message = {
//   GET_STATE: [BaseMessage<{ tabId: Int }>, MessageResponse<{}>];
//   ARCHIVE_TAB: [BaseMessage<{ tabId: Int }>, MessageResponse<{}>];
//   CHECK_ARCHIVE: [BaseMessage<{ tabId: Int }>, MessageResponse<Result<Status>>];
//   ARCHIVE_FROM_PAGE: [BaseMessage<{ tabId: Int }>, MessageResponse<{}>];
//   REFRESH_PENDING: [BaseMessage<undefined>, MessageResponse<{}>];
//   OPEN_AND_ARCHIVE: [BaseMessage<{ url: Url }>, MessageResponse<{}>];
//   CLEAR_ARCHIVE_ERROR: [BaseMessage<{ tabId: Int }>, MessageResponse<{}>];
// };

// export type MessageType = keyof Message;

// /**
//  * Sends a strongly-typed message to the background service worker/script
//  */
// export async function sendToBackground<T extends MessageType>(
//   message: Message[T][0],
// ): Promise<Message[T][1]> {
//   try {
//     const response = (await browser.runtime.sendMessage(message)) as Message[T][1];
//     if (response !== null && response !== undefined) {
//       return { success: true, data: response };
//     }
//     log.error(`message:${message.type} No Response received`);
//     return { success: false, error: "No response received" };
//   } catch (err) {
//     log.error(`message:${message.type} send failed`, err);
//     return {
//       success: false,
//       error: err instanceof Error ? err.message : String(err),
//     };
//   }
// }

export type Empty = Record<string, never>;

/**
 * Single source of truth: each message type maps to its payload and the data
 * a successful response carries.
 */
export interface MessageMap {
  GET_STATE: { payload: { tabId: Int }; data: State };
  ARCHIVE_TAB: {
    payload: { tabId: Int };
    data: Result<{
      status: Status | null;
      response: string | { ok: boolean };
      warnings: string[];
    }>;
  };
  CHECK_ARCHIVE: { payload: { tabId: Int }; data: Result<Status> };
  ARCHIVE_FROM_PAGE: {
    payload: undefined;
    data: Result<{
      status: Status | null;
      response: string | { ok: boolean };
      warnings: string[];
    }>;
  };
  REFRESH_PENDING: { payload: undefined; data: { ok: boolean } };
  OPEN_AND_ARCHIVE: { payload: { url: Url }; data: void };
  CLEAR_ARCHIVE_ERROR: { payload: { tabId: Int }; data: { ok: true } };
}

export type MessageType = keyof MessageMap;
export type MessagePayload<T extends MessageType> = MessageMap[T]["payload"];
export type MessageData<T extends MessageType> = MessageMap[T]["data"];

/** Discriminated union of every possible message (narrows on `type`). */
export type Message<T extends MessageType = MessageType> = {
  [K in T]: { type: K; payload: MessagePayload<K> };
}[T];

export interface ErrorMessageResponse {
  success: false;
  error: string;
}

export interface OkMessageResponse<T = unknown> {
  success: true;
  data: T;
}

export type MessageResponse<T> = OkMessageResponse<T> | ErrorMessageResponse;

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
): Promise<MessageResponse<MessageData<T>>> {
  const message = { type, payload: args[0] } as Message<T>;
  try {
    const response: unknown = await browser.runtime.sendMessage(message);
    if (!isMessageResponse<MessageData<T>>(response)) {
      log.error(`message:${type} No/invalid response received`);
      return { success: false, error: "No response received" };
    }
    return response;
  } catch (err) {
    log.error(`message:${type} send failed`, err);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function isMessageResponse<D>(value: unknown): value is MessageResponse<D> {
  if (typeof value !== "object" || value === null || !("success" in value)) {
    return false;
  }
  const v = value as { success: unknown; error?: unknown };
  return v.success === true || (v.success === false && typeof v.error === "string");
}
