import type {
  Configured,
  Int,
  ArchiveStatus,
  Url,
  ApiSuccessArchiveResponse,
  ApiArchiveVersionsResponse,
  PendingResponseInStorage,
} from "./types.js";
import { createError, createOk, Result } from "./error.js";

export type Empty = Record<string, never>;

/**
 * Single source of truth: each message type maps to its payload and the data
 * a successful response carries.
 */
export interface MessageMap {
  GET_CONFIGURED: { payload: undefined; data: Configured };
  GET_ARCHIVE: { payload: undefined; data: ArchiveStatus };
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
    data: Result<{
      status: ArchiveStatus | null;
      response: string | { ok: boolean };
      warnings: string[];
    }>;
  };
  CLEAR_ARCHIVE_ERROR: { payload: { tabId: Int }; data: { ok: true } };
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
  console.debug(`message:${type} →`, args[0]);
  try {
    const response: unknown = await _sendMessage(message);
    if (!isMessageResponse<MessageData<T>>(response)) {
      console.error(`message:${type} No/invalid response received`, response);
      return { ok: false, messages: ["No response received"], extra: [] };
    }
    console.debug(`message:${type} ← ok`);
    return response;
  } catch (err) {
    console.error(`message:${type} send failed`, err);
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
const sleep = (ms: number = 0) => new Promise((r) => setTimeout(r, ms));

let versionIndex = 0;
let versions: ApiArchiveVersionsResponse["versions"] = [];
const pending = [
  ["uuid-01", "https://www.wikipedia.org", "Global Knowledge Hub", "2026-10-20T07:12:34.000Z"],
  [
    "uuid-02",
    "https://www.nationalgeographic.com",
    "Explore the Natural World",
    "2026-10-01T08:25:10.000Z",
  ],
  [
    "uuid-03",
    "https://www.github.com",
    "Developer Collaboration Platform",
    "2026-10-02T09:41:52.000Z",
  ],
  ["uuid-04", "https://www.bbc.com", "World News and Updates", "2026-10-03T10:05:18.000Z"],
  ["uuid-05", "https://www.nasa.gov", "Space Exploration News", "2026-10-04T10:37:44.000Z"],
  ["uuid-06", "https://www.medium.com", "Ideas and Personal Stories", "2026-10-05T11:14:29.000Z"],
  [
    "uuid-07",
    "https://www.stackoverflow.com",
    "Programming Questions and Answers",
    "2026-10-06T11:52:03.000Z",
  ],
  ["uuid-08", "https://www.mozilla.org", "Open Web and Browser Tools", "2026-10-07T12:08:16.000Z"],
  ["uuid-09", "https://www.khanacademy.org", "Free Online Learning", "2026-10-08T12:19:47.000Z"],
  [
    "uuid-10",
    "https://www.archive.org",
    "Digital Library and Web Archives",
    "2026-10-09T12:40:00.000Z",
  ],
  [
    "uuid-11",
    "https://www.reuters.com",
    "Global Business and Market News",
    "2026-10-10T13:02:35.000Z",
  ],
  [
    "uuid-12",
    "https://www.coursera.org",
    "Online Courses and Certifications",
    "2026-10-11T13:27:11.000Z",
  ],
  [
    "uuid-13",
    "https://www.openstreetmap.org",
    "Community-Powered World Map",
    "2026-10-12T14:16:58.000Z",
  ],
  [
    "uuid-14",
    "https://www.pbs.org",
    "Educational Media and Documentaries",
    "2026-10-13T15:03:22.000Z",
  ],
  [
    "uuid-15",
    "https://www.allrecipes.com",
    "Recipes and Cooking Inspiration",
    "2026-10-14T16:45:39.000Z",
  ],
]
  .map(([id, url, title, addedAt]) => {
    return { id, url, title, addedAt };
  })
  .sort(({ addedAt: b }, { addedAt: a }) => {
    return a < b ? -1 : a > b ? 1 : 0;
  });

let pendingFetchedAt = Date.now();
async function _sendMessage<T extends MessageType>({
  type,
}: Message<T>): Promise<Result<MessageData<T>>> {
  await sleep();
  switch (type) {
    case "GET_CONFIGURED":
      return createOk({
        server: true,
        archive: true,
        pending: true,
        check: true,
      });
    case "GET_ARCHIVE":
      if (Math.random() > 0.5) {
        versionIndex += 1;
        versions.push({
          id: `uuid-${versionIndex.toString().padStart(2, "0")}`,
          archivedAt: new Date().toISOString(),
          url: "https://example.com",
          title: "Example Title",
          htmlSize: 500,
          hasScreenshot: false,
        });
      }
      return createOk({
        state: "ok",
        url: "https://example.com",
        checkedAt: Date.now(),
        archived: versions.length !== 0,
        count: versions.length,
        versions,
        lastArchivedAt: versions.length > 0 ? versions[versions.length - 1].archivedAt : undefined,
      });
    case "GET_PENDING":
      return createOk({
        items: pending,
        total: pending.length,
        fetchedAt: pendingFetchedAt,
        error: "",
      });
    case "ARCHIVE_TAB":
      versionIndex += 1;
      versions.push({
        id: `uuid-${versionIndex.toString().padStart(2, "0")}`,
        archivedAt: new Date().toISOString(),
        url: "https://example.com",
        title: "Example Title",
        htmlSize: 500,
        hasScreenshot: false,
      });
      return createOk({
        warnings: [],
        response: {
          success: true,
          message: "Archived success fully",
          id: "uuid-05",
          url: "https://archive.example.com",
          archivedAt: "2026-10-18T13:27:27.003Z",
          versionCount: 1,
        },
      });

    case "OPEN_AND_ARCHIVE":
      return createOk(undefined);
    case "REFRESH_PENDING":
      pending.pop();
      await sleep(2000);
      pendingFetchedAt = Date.now();
      return createOk({ ok: true });

    default:
      return createError({
        message: `Unknown message: ${type}`,
      });
  }
}
