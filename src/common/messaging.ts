import browser from "webextension-polyfill";
import { BaseMessage, MessageResponse } from "./types.ts";
import { log } from "./index.ts";

/**
 * Sends a strongly-typed message to the background service worker/script
 */
export async function sendToBackground<TPayload = unknown, TResponseData = unknown>(
  message: BaseMessage<TPayload>,
): Promise<MessageResponse<TResponseData>> {
  try {
    log.debug(`Sending message:${message.type} to background`);
    const response = (await browser.runtime.sendMessage(message)) as MessageResponse<TResponseData>;
    return response ?? { success: false, error: "No response received" };
  } catch (err) {
    log.error(`message:${message.type} send failed`, err);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
