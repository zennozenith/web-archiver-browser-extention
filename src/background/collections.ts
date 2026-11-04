import { ok, wrapErr } from "@common/error";
import { bgRootlog } from "@common/log";
import { reqwest } from "./reqwest";
import type { CollectionRecord } from "@common/api-types";
import { errorIfServerUnconfigured, getExtensionSettings } from "@common/settings";
import { createUrl } from "@common/index";

const log = bgRootlog.child("collections");

export type ListCollections = Awaited<ReturnType<typeof listCollections>>;

/** `GET /api/collection` — the flat list shown in the popup select. */
export async function listCollections() {
  const { serverUrl, token } = await getExtensionSettings();
  const [, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return wrapErr(serverUnconfigured);

  const [collections, error] = await reqwest<CollectionRecord[]>(
    createUrl(serverUrl, "/api/collection"),
    { token, timeoutMs: 20000 },
  );
  if (error) return wrapErr(error);

  return ok(collections);
}
