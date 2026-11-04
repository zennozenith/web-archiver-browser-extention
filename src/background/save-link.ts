import browser from "webextension-polyfill";

import { ok, wrapErr } from "@common/error";
import { bgRootlog } from "@common/log";
import type { IdLessTag, Int, Int64 } from "@common/types";
import { canonicalizeUrl, extractTabUrl } from "@common/index";
import { errorIfServerUnconfigured, getExtensionSettings } from "@common/settings";
import { createPage } from "./page";
import { archivePage } from "./archive";

const log = bgRootlog.child("save-link");

export interface SaveLinkPayload {
  tabId: Int;
  displayTitle?: string;
  description?: string;
  /** Numeric collection id as a string; `null` means Unsorted. */
  collectionId: string | null;
  pinned: boolean;
  tags: IdLessTag[];
  /** Also capture a snapshot right after the link is created. */
  archive: boolean;
}

export interface SaveLinkResult {
  pageId: Int64;
  archived: boolean;
  /** Non-fatal problems, e.g. the link was saved but the snapshot failed. */
  warnings: string[];
}

export type SaveLink = Awaited<ReturnType<typeof saveLink>>;

/**
 * Create a link, then optionally archive the current tab.
 *
 * Once `POST /api/page` succeeds the link exists, so an archive failure is
 * returned as a warning instead of failing the whole operation.
 */
export async function saveLink({ tabId, ...input }: SaveLinkPayload) {
  const { serverUrl } = await getExtensionSettings();
  const [, serverUnconfigured] = errorIfServerUnconfigured({ serverUrl }, log);
  if (serverUnconfigured !== null) return wrapErr(serverUnconfigured);

  const [url, urlError] = await extractTabUrl(tabId, log);
  if (urlError) return wrapErr(urlError);

  const tab = await browser.tabs.get(tabId);
  const canonicalUrl = canonicalizeUrl(url);

  const [page, createError] = await createPage({
    url: canonicalUrl,
    displayTitle: input.displayTitle?.trim() || tab.title?.trim() || canonicalUrl,
    description: input.description?.trim(),
    collectionId: input.collectionId,
    pinned: input.pinned,
    tags: input.tags,
  });
  if (createError) return wrapErr(createError);

  const warnings: string[] = [];
  let archived = false;

  if (input.archive) {
    const [snapshot, archiveError] = await archivePage(tabId, page.id);
    if (archiveError) {
      warnings.push(`The link was saved, but the snapshot failed: ${archiveError.detail}`);
    } else {
      archived = true;
      warnings.push(...snapshot.warnings);
    }
  }

  return ok({ pageId: page.id, archived, warnings });
}
