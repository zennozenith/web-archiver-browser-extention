import type { Int } from "@common/types";
import { bgRootlog as log } from "@common/log";
import { BannerOpts, pageBanner } from "./content-scripts";

export async function injectBanner(tabId: Int, opts: BannerOpts): Promise<void> {
  try {
    await browser.scripting.executeScript({ target: { tabId }, func: pageBanner, args: [opts] });
  } catch {
    log.warn("restricted page, cannot inject banner", { tabId, mode: opts.mode });
  }
}
