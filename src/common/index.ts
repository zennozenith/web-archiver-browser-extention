import type { Url } from "./types.ts";

export * from "./types.ts";
export * from "./constants.ts";
export * from "./time.ts";
export * from "./storage.ts";
export * from "./settings.ts";
export * from "./messaging.ts";
export * from "./document.ts";
export * from "./reqwest.ts";
export * from "./log.ts";
export * from "./logger.ts";

/* ---------- helpers ---------- */
export const isHttp = (url?: Url) => /^https?:\/\//i.test(url || "");
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
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// /**
//  * Tolerant parsers: accept several common response shapes.
//  */
// export function normalizeCheck(data: Record<string, unknown>): CheckUrlResponse {
//   if (!data || typeof data !== "object") return { archived: false, count: 0, versions: [] };

//   let list = (data.versions || data.snapshots || data.archives || data.items || []) as Array<any>;

//   if (!Array.isArray(list)) list = [];

//   let versions = list.map((v: any) =>
//     typeof v === "object" && v
//       ? {
//           id: v.id ?? v.version ?? null,
//           time:
//             v.archivedAt ??
//             v.archived_at ??
//             v.created_at ??
//             v.createdAt ??
//             v.timestamp ??
//             v.time ??
//             v.date ??
//             null,
//           url: v.url ?? v.link ?? null,
//         }
//       : { id: null, time: v, url: null },
//   );
//   versions.sort((a, b) => ((toDate(b.time) || 0) as any) - ((toDate(a.time) || 0) as any));

//   const count =
//     Number(
//       data.count ??
//         data.versionCount ??
//         data.version_count ??
//         data.versions_count ??
//         versions.length,
//     ) || 0;
//   const archived = Boolean(data.archived ?? data.exists ?? data.found ?? count > 0);
//   const last = (data.lastArchivedAt ??
//     data.last_archived_at ??
//     data.latest ??
//     versions[0]?.time ??
//     null) as string | null;
//   return { archived, count, versions, last };
// }

// /**
//  * Tolerant parsers: accept several common response shapes and returns Pending
//  */
// export function normalizePending(data: Record<string, unknown>): Pending {
//   let arr = Array.isArray(data)
//     ? data
//     : (((data && (data.urls || data.items || data.pending || data.results || data.data)) ||
//         []) as Array<any>);
//   if (!Array.isArray(arr)) arr = [];

//   return {
//     items: arr
//       .map((x: any) =>
//         typeof x === "string"
//           ? { url: x }
//           : {
//               url: x.url || x.href || x.link,
//               title: x.title || x.name || "",
//               addedAt: x.addedAt ?? x.added_at ?? x.created_at ?? x.createdAt ?? null,
//             },
//       )
//       .filter((x) => isHttp(x.url)) as Pending["items"],
//     error: data.error,
//     fetchedAt: data.error,
//     total: data.error,
//   } as Pending;
// }
