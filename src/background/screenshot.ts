import { createError, createOk, isStandardError, Result } from "@common/error";
import browser from "webextension-polyfill";
import { bgRootlog } from "@common/log";
import { ExtensionSettings } from "@common/settings";
import { Page } from "./content-scripts";

const log = bgRootlog.child("screenshot");

export interface Screenshot {
  blob: Blob;
  ext: "jpg" | "png";
  format: ExtensionSettings["screenshotFormat"];
}

export async function takeScreenshot({
  tab,
  extensionSettings,
  page,
  warnings,
}: {
  tab: browser.Tabs.Tab;
  extensionSettings: ExtensionSettings;
  page: Page;
  warnings: string[];
}): Promise<Result<Screenshot>> {
  const format = extensionSettings.screenshotFormat;
  const opts: { format: ExtensionSettings["screenshotFormat"]; quality?: number } = { format };
  if (format === "jpeg") opts.quality = Number(extensionSettings.jpegQuality) || 85;

  let dataUrl;

  if (typeof browser.tabs.captureTab === "function") {
    // Firefox
    if (extensionSettings.fullPageScreenshot) {
      try {
        dataUrl = await browser.tabs.captureTab(tab.id, {
          ...opts,
          scale: 1,
          rect: {
            x: 0,
            y: 0,
            width: Math.min(page.scrollWidth, 16384),
            height: Math.min(page.scrollHeight, 16384),
          },
        });
      } catch (e) {
        const errorMessage = isStandardError(e) ? e.message : String(e);
        warnings.push(
          `Full-page screenshot failed (${errorMessage}); captured the viewport instead`,
        );
      }
    }
    dataUrl = dataUrl || (await browser.tabs.captureTab(tab.id, opts));
  } else {
    // Chrome: only the visible tab can be captured
    if (!tab.active) {
      warnings.push("Screenshot skipped: tab is not in the foreground");
      return createError({
        logger: log,
        message: "Screenshot skipped: tab is not in the foreground",
      });
    }
    dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, opts);
  }
  return createOk({
    blob: await (await fetch(dataUrl)).blob(),
    ext: format === "jpeg" ? "jpg" : "png",
    format,
  });
}
