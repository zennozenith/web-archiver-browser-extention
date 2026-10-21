import { bgRootlog } from "@common/log";
import { getExtentionSettings } from "@common/settings";

const log = bgRootlog.child("badge");

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
    const extentionSettings = await getExtentionSettings();

    if (!extentionSettings.showBadge && !force) {
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
