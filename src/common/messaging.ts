import browser from "webextension-polyfill";
import type { Int, Int64, Vec } from "./types.ts";
import { log as rootLog } from "./log.ts";
import type { Err, Fail, Ok, Result } from "./error.ts";
import { err } from "./error.ts";
import type { TestEndpointResponse } from "@src/background/reqwest.ts";
import type { StorageExtensionSettings } from "./settings.ts";
import type { PageLookupFull } from "@src/background/page.ts";
import type {
  GetPendingFromStorage,
  RefreshPending,
  SetPendingTags,
} from "@src/background/pending.ts";
import type { GetLocalPageTags, IdLessTag, ListTags, SetPageTag } from "@src/background/tags.ts";
import type { ArchiveTab } from "@src/background/archive.ts";

const log = rootLog.child("messaging");

export type Empty = Record<string, never>;

/**
 * Single source of truth: each message type maps to its payload and the data
 * a successful response carries.
 */
export interface MessageMap {
  GET_EXTENSION_SETTINGS: { payload: undefined; data: Ok<StorageExtensionSettings> };
  TEST_ENDPOINTS: {
    payload: { serverUrl: string; token?: string };
    data: Ok<TestEndpointResponse[]>;
  };
  PAGE_LOOKUP_FULL: { payload: { tabId: Int }; data: PageLookupFull };
  GET_PENDING: { payload: undefined; data: GetPendingFromStorage };
  REFRESH_PENDING: { payload: undefined; data: RefreshPending };
  SET_PENDING_TAGS: { payload: { id: Int64; tags: Vec<IdLessTag> }; data: SetPendingTags };
  SET_PAGE_TAGS: {
    payload: { idOrUrl: string | Int64; url: string; tags: Vec<IdLessTag> };
    data: SetPageTag;
  };
  GET_LOCAL_TAGS: { payload: { url: string }; data: GetLocalPageTags };
  ARCHIVE_TAB: { payload: { tabId: Int; tags: Vec<IdLessTag> }; data: ArchiveTab };
  LIST_TAGS: { payload: undefined; data: ListTags };
  OPEN_AND_ARCHIVE: { payload: { url: string; tags?: string[] }; data: Result<boolean> };
  ARCHIVE_FROM_PAGE: {
    payload: { tags: Vec<IdLessTag> };
    data: ArchiveTab | Fail<{ reason: "no_tab_id"; detail: string }>;
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

export type SendToBackground<T extends MessageType> = Awaited<
  ReturnType<typeof sendToBackground<T>>
>;
/**
 * Sends a strongly-typed message to the background service worker/script.
 * `T` is inferred from `type`, so payload and return type are both checked.
 */
export async function sendToBackground<const T extends MessageType = MessageType>(
  type: T,
  ...args: PayloadArgs<T>
) {
  const message = { type, payload: args[0] } as Message<T>;
  log.debug(`message:${type} →`, args[0]);
  try {
    const response = await browser.runtime.sendMessage(message);

    if (!isMessageResponse<T>(response)) {
      return err({
        logger: log,
        reason: "no_response",
        detail: `message:${type} No/invalid response received`,
        extra: { message },
      });
    }
    log.debug(`detail:${type} ← ok`);
    return response;
  } catch (e) {
    return err({
      logger: log,
      reason: "send_to_background_failed",
      detail: `detail:${type} send failed`,
      extra: e,
    });
  }
}

export function isMessageResponse<T extends MessageType>(value: unknown): value is MessageData<T> {
  if (!Array.isArray(value) || value.length !== 2) return false;

  const [data, error] = value;

  // Ok case: [data, null] — data must not be null
  if (error === null) {
    return data !== null && data !== undefined;
  }

  // Err case: [null, error] — data must be null, error must be an Err
  if (data !== null) return false;
  return isErr(error);
}

function isErr(value: unknown): value is Err {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Err).reason === "string" &&
    typeof (value as Err).detail === "string"
  );
}
