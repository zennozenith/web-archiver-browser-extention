import { createError, createOk, type Result } from "@common/error";
import { log as rootLog } from "@common/log";
import { request } from "./reqwest";
import type { Url } from "@common/types";
import { getEndpoint, getExtentionSettings } from "@common/settings";

/* Client for the server's tag API
 *   GET  /api/tags        all tags with usage counts
 *   PUT  /api/sites/tags  { url, tags: [...] } replace a website's tag set
 *
 * Tags are site-wide: every archived version of a URL shares the same list.
 * Unknown tag names sent to the server are created automatically;
 * removals must go through PUT /api/sites/tags (the POST /api/archive merge
 * only ever adds tags). */

const log = rootLog.child("tags");

export interface ApiTagRef {
  id: string;
  name: string;
}

export interface ApiTag extends ApiTagRef {
  usage: number;
}

export interface ApiTagsListResponse {
  items: ApiTag[];
  total: number;
}

export interface ApiSiteTagsResponse {
  success: true;
  url: Url;
  tags: ApiTagRef[];
}

/** All tags known to the server, with usage counts (where used: suggestions/autocomplete). */
export async function listTags({ timeoutMs = 20000 }: { timeoutMs?: number } = {}): Promise<
  Result<ApiTag[]>
> {
  const settings = await getExtentionSettings();
  const endpoint = getEndpoint(settings);
  if (!endpoint.tags) {
    log.debug("Tags URL not configured, cannot list tags");
    return createError({
      logger: log,
      message: "Tags URL is not configured. Open the extension preferences.",
    });
  }

  const res = await request<ApiTagsListResponse>(endpoint.tags, {
    token: settings.apiToken,
    timeoutMs,
  });
  if (!res.ok) {
    return res;
  }
  return createOk(res.data.items);
}

/** Replace the tag set of a website. Unknown tag names are created server-side. */
export async function setSiteTags(
  url: Url,
  tags: string[],
  { timeoutMs = 20000 }: { timeoutMs?: number } = {},
): Promise<Result<ApiTagRef[]>> {
  const settings = await getExtentionSettings();
  const endpoint = getEndpoint(settings);
  if (!endpoint.sitesTags) {
    log.debug("Sites-tags URL not configured, cannot set tags");
    return createError({
      logger: log,
      message: "Site tags URL is not configured. Open the extension preferences.",
    });
  }

  const names = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
  const res = await request<ApiSiteTagsResponse>(endpoint.sitesTags, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, tags: names }),
    token: settings.apiToken,
    timeoutMs,
  });
  if (!res.ok) {
    return res;
  }
  return createOk(res.data.tags);
}
