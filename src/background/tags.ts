import { ok, wrapErr } from "@common/error";
import { log as rootLog } from "@common/log";
import { reqwest } from "./reqwest";
import type { Option, Int64, Vec } from "@common/types";
import { errorIfServerUnconfigured, getExtensionSettings } from "@common/settings";
import { sync_storage_set } from "@common/storage";
import { canonicalizeUrl, createUrl } from "@common/index";

/* Client for the server's tag API
 *   GET  /api/tags              all tags with usage counts
 *   PUT  /api/pages/:id/tags    replace a page's (site-wide) tag set
 *
 * Tags are site-wide: every archived version of a URL shares the same list.
 * Unknown tag names are created server-side. Removals must go through the PUT
 * (the POST /api/archive merge only ever adds tags). */

const log = rootLog.child("tags");

export interface IdLessTag {
  name: string;
  color: Option<string>; // palette key, never a hex value
}

export interface TagDto extends IdLessTag {
  id: Int64;
  createdAt: Int64;
}

export interface TagWithCountDto {
  id: Int64;
  name: string;
  color: Option<string>;
  created_at: Int64;
  pages: Int64;
  pending: Int64;
}

/** Strip server-only fields so the store only ever holds { name, color }. */
const normalize = (t: IdLessTag): IdLessTag => ({
  name: t.name.trim(),
  color: t.color ?? null,
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
    return this._tags.map((t) => ({ ...t }));
  }

  /** Replace the whole list, deduplicating by name. Later entries win. */
  set tags(next: readonly IdLessTag[]) {
    const byName = new Map<string, IdLessTag>();
    for (const t of next) {
      const n = normalize(t);
      if (n.name) byName.set(n.name, n);
    }
    this._tags = [...byName.values()];
  }

  get(name: string): IdLessTag | undefined {
    return this._tags.find((t) => t.name === name);
  }

  /** Insert, or update an existing tag. A null color keeps the existing color. */
  upsertTag(tag: IdLessTag): void {
    const n = normalize(tag);
    if (!n.name) return;
    const i = this._tags.findIndex((t) => t.name === n.name);
    if (i === -1) this._tags.push(n);
    else this._tags[i] = { name: n.name, color: n.color ?? this._tags[i].color };
  }

  removeTag(name: string): void {
    this._tags = this._tags.filter((t) => t.name !== name);
  }

  hasTag(name: string): boolean {
    return this._tags.some((t) => t.name === name);
  }
}

/** All tags known to the server, with usage counts (for suggestions/autocomplete). */
export async function listTags({ timeoutMs = 20000 }: { timeoutMs?: number } = {}) {
  const { serverUrl, token } = await getExtensionSettings();
  const [_, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return wrapErr(serverUnconfigured);

  return reqwest<Vec<TagWithCountDto>>(createUrl(serverUrl, "/api/tags"), { token, timeoutMs });
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
  const [_, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return wrapErr(serverUnconfigured);

  // TODO: server only accetps tag name for now
  const body = { tags: new TagStore(tags).tags };

  // returns TagDto, for typing, returning IdLessTag
  return reqwest<Vec<IdLessTag>>(createUrl(serverUrl, `/api/pages/${pageId}/tags`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    token,
    timeoutMs,
  });
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
