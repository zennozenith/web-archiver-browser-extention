import type { Url } from "./types.ts";

// export * from "./types.ts";
// export * from "./constants.ts";
// export * from "./time.ts";
// export * from "./storage.ts";
// export * from "./settings.ts";
// export * from "./messaging.ts";
// export * from "./document.ts";
// export * from "./log.ts";
// export * from "./logger.ts";

/* ---------- helpers ---------- */
export const isHttp = (url: Url) => /^https?:\/\//i.test(url || "");
export const isArchivable = isHttp;

export function normalizeUrl(url: string): string {
  try {
    const parsedUrl = new URL(url.trim());
    parsedUrl.hash = "";
    return parsedUrl.toString();
  } catch {
    return url;
  }
}

export async function sha256(input: string | Blob | File | Response): Promise<string> {
  const buf =
    typeof input === "string" ? new TextEncoder().encode(input) : await input.arrayBuffer();
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Vec(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
