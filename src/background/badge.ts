import { bgRootlog } from "@common/log";
import { getExtensionSettings } from "@common/settings";
import { Int } from "@common/types";
import { formatTimeFromSec } from "@common/time";
import { PageLookupFull } from "./page";

const log = bgRootlog.child("badge");

export function applyStatusBadge(tabId: Int, lookupPageResult?: PageLookupFull): Promise<void> {
  if (!lookupPageResult) {
    return updateBadge({
      tabId,
      text: "",
      title: "Web Archiver",
    });
  }

  const [page, error] = lookupPageResult;
  if (error) {
    return updateBadge({
      tabId,
      text: "!",
      color: "#d93025",
      title: `Archive status unavailable: ${error.detail}`,
    });
  }

  const [lookupPage, _] = page;
  const n = lookupPage.captureCount;
  const when = lookupPage.lastCapturedAt;
  const tagNames = lookupPage.tags.map((v) => v.name);

  return updateBadge({
    tabId,
    text: n ? (n > 99 ? "99+" : String(n)) : "✓",
    color: "#188038",
    title:
      `Archived${n ? ` — ${n} version${n === 1 ? "" : "s"}` : ""}` +
      (tagNames.length ? `\nTags: ${tagNames.join(", ")}` : "") +
      (when ? `\nLast: ${formatTimeFromSec(when)}` : ""),
  });
}

/**
 * Update the extension action badge text with the number of archive versions
 */
export async function updateBadge({
  text,
  force = false,
  color,
  tabId,
  title,
}: {
  text: string;
  title?: string;
  color?: string;
  tabId?: number;
  force?: boolean;
}): Promise<void> {
  try {
    const extensionSettings = await getExtensionSettings();

    if (!extensionSettings.showBadge && !force) {
      await browser.action.setBadgeText({ text: "", tabId });
      return;
    }

    await browser.action.setBadgeText({ tabId, text });
    if (color) await browser.action.setBadgeBackgroundColor({ tabId, color });
    if (title) await browser.action.setTitle({ tabId, title });
    log.debug("Badge updated", { tabId, text });
  } catch (err) {
    log.warn("Could not update badge", { tabId, text }, err);
  }
}
