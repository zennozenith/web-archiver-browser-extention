import { ok, wrapErr } from "@common/error";
import { log as rootLog } from "@common/log";
import { reqwest } from "./reqwest";
import type { ReplaceTagsRequest, Tag, TagSummary } from "@common/api-types";
import type { IdLessTag, Int64 } from "@common/types";
import { errorIfServerUnconfigured, getExtensionSettings } from "@common/settings";
import { sync_storage_get, sync_storage_set } from "@common/storage";
import { canonicalizeUrl, createUrl } from "@common/index";

export type { IdLessTag };

/* Client for the server's tag API
 *   GET  /api/tag             all tags with usage counts
 *   PUT  /api/page/:id/tag    replace a page's (site-wide) tag set
 *
 * Tags are site-wide: every archived version of a URL shares the same list.
 * Unknown tag names are created server-side. Removals must go through the PUT
 * (the archive endpoint only attaches the tags present on the page row). */

const log = rootLog.child("tags");

/** Strip server-only fields so the store only ever holds { name, color }. */
const normalize = (tag: IdLessTag): IdLessTag => ({
  name: tag.name.trim(),
  color: tag.color ?? null,
});

export class TagStore {
  private _tags: IdLessTag[] = [];

  constructor(tags: readonly IdLessTag[] = []) {
    this.tags = tags;
  }

  get length(): number {
    return this._tags.length;
  }

  /** A copy, so callers can't mutate internal state. */
  get tags(): IdLessTag[] {
    return this._tags.map((tag) => ({ ...tag }));
  }

  /** Replace the whole list, deduplicating by name. Later entries win. */
  set tags(next: readonly IdLessTag[]) {
    const byName = new Map<string, IdLessTag>();
    for (const tag of next) {
      const normalized = normalize(tag);
      if (normalized.name) byName.set(normalized.name, normalized);
    }
    this._tags = [...byName.values()];
  }

  get(name: string): IdLessTag | undefined {
    return this._tags.find((tag) => tag.name === name);
  }

  /** Insert, or update an existing tag. A null color keeps the existing color. */
  upsertTag(tag: IdLessTag): void {
    const normalized = normalize(tag);
    if (!normalized.name) return;
    const index = this._tags.findIndex((tag) => tag.name === normalized.name);
    if (index === -1) this._tags.push(normalized);
    else
      this._tags[index] = {
        name: normalized.name,
        color: normalized.color ?? this._tags[index].color,
      };
  }

  removeTag(name: string): void {
    this._tags = this._tags.filter((tag) => tag.name !== name);
  }

  hasTag(name: string): boolean {
    return this._tags.some((tag) => tag.name === name);
  }
}

export type ListTags = Awaited<ReturnType<typeof listTags>>;

/** All tags known to the server, with usage counts (for suggestions). */
export async function listTags({ timeoutMs = 20000 }: { timeoutMs?: number } = {}) {
  const { serverUrl, token } = await getExtensionSettings();
  const [, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return wrapErr(serverUnconfigured);

  const [tags, error] = await reqwest<TagSummary[]>(createUrl(serverUrl, "/api/tag"), {
    token,
    timeoutMs,
  });
  if (error) return wrapErr(error);

  return ok(tags.filter((tag) => tag.name.length > 0));
}

export type SetPageTag =
  | Awaited<ReturnType<typeof setRemotePageTag>>
  | Awaited<ReturnType<typeof setLocalPageTag>>;

/** Replace the tag set of a page on the server. */
export async function setRemotePageTag(
  pageId: Int64,
  tags: readonly IdLessTag[],
  { timeoutMs = 20000 }: { timeoutMs?: number } = {},
) {
  const { serverUrl, token } = await getExtensionSettings();
  const [, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return wrapErr(serverUnconfigured);

  const body: ReplaceTagsRequest = {
    tags: new TagStore(tags).tags.map(({ name, color }) => ({ name, color })),
  };

  const [saved, error] = await reqwest<Tag[]>(createUrl(serverUrl, `/api/page/${pageId}/tag`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    token,
    timeoutMs,
  });
  if (error) return wrapErr(error);

  return ok(new TagStore(saved).tags);
}

/** Store the tag set locally for a URL that isn't archived yet. */
export async function setLocalPageTag(url: string, tags: readonly IdLessTag[]) {
  const clean = new TagStore(tags).tags;
  try {
    await sync_storage_set(`tags:${canonicalizeUrl(url)}`, clean);
    return ok(clean);
  } catch (e) {
    log.error("Cannot save local tags", e);
    return wrapErr({ reason: "storage", detail: String(e) });
  }
}

export type GetLocalPageTags = Awaited<ReturnType<typeof getLocalPageTags>>;

/** Read tags saved locally for a URL that isn't archived yet. */
export async function getLocalPageTags(url: string) {
  const key = `tags:${canonicalizeUrl(url)}`;
  try {
    const tags = (await sync_storage_get<IdLessTag[]>(key)) ?? [];
    return ok(new TagStore(tags).tags);
  } catch (e) {
    log.error("Cannot read local tags", e);
    return wrapErr({ reason: "storage", detail: String(e) });
  }
}
