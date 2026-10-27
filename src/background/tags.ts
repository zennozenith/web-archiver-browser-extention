import { err } from "@common/error";
import { log as rootLog } from "@common/log";
import { request } from "./reqwest";
import type { Option, Int64, Vec } from "@common/types";
import { errorIfServerUnconfigured, getExtensionSettings } from "@common/settings";
import { createUrl } from "@common/index";

/* Client for the server's tag API
 *   GET  /api/tags        all tags with usage counts
 *   PUT  /api/sites/tags  { url, tags: [...] } replace a website's tag set
 *
 * Tags are site-wide: every archived version of a URL shares the same list.
 * Unknown tag names sent to the server are created automatically;
 * removals must go through PUT /api/sites/tags (the POST /api/archive merge
 * only ever adds tags). */

const log = rootLog.child("tags");

export interface IdLessTag {
  name: string;
  color: Option<string>; // palette key, never a hex value
}

export interface TagDto {
  id: Int64;
  createdAt: Int64;
  name: string;
  color: Option<string>; // palette key, never a hex value
}

export interface TagWithCountDto {
  id: Int64;
  name: string;
  color: Option<string>;
  created_at: Int64;
  pages: Int64;
  pending: Int64;
}

// export interface PageTags {
//   success: true;
//   url: Url;
//   tags: Vec<ApiTag>;
// }

/** All tags known to the server, with usage counts (where used: suggestions/autocomplete). */
export async function listTags({ timeoutMs = 20000 }: { timeoutMs?: number } = {}) {
  const { serverUrl, token } = await getExtensionSettings();
  const [_, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return err(serverUnconfigured);

  const res = await request<Vec<TagWithCountDto>>(createUrl(serverUrl, "/api/tags"), {
    token,
    timeoutMs,
  });

  return res;
}

/** Replace the tag set of a website. Unknown tag names are created server-side. */
export async function setPageTag(
  pageId: Int64,
  tags: Vec<IdLessTag>,
  { timeoutMs = 20000 }: { timeoutMs?: number } = {},
) {
  const { serverUrl, token } = await getExtensionSettings();
  const [_, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return err(serverUnconfigured);

  const names = [...new Set(tags.map((t) => t.name.trim()).filter(Boolean))];
  const res = await request<Vec<TagDto>>(createUrl(serverUrl, `/api/pages/${pageId}/tags`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags: names }),
    token,
    timeoutMs,
  });

  return res;
}
