import type { Endpoint, OverrideUrl, Url } from "./types";

export function getEndpoint({
  checkUrl,
  pendingUrl,
  serverUrl,
}: {
  checkUrl: OverrideUrl;
  pendingUrl: OverrideUrl;
  serverUrl: Url;
}): Endpoint {
  const baseUrl = (serverUrl ?? "").trim().replace(/\/+\$/, "");

  const derivedUrls =
    baseUrl !== ""
      ? {
          pending: `${baseUrl}/api/pending`,
          check: `${baseUrl}/api/check`,
        }
      : {
          pending: "",
          check: "",
        };

  return {
    server: baseUrl,
    pending: pendingUrl.override ? pendingUrl.url : derivedUrls.pending,
    check: checkUrl.override ? checkUrl.url : derivedUrls.check,
  };
}

export function buildCheckUrl(checkUrl: Url, pageUrl: Url) {
  if (checkUrl.includes("{url}")) return checkUrl.replace("{url}", encodeURIComponent(pageUrl));
  const url = new URL(checkUrl);
  url.searchParams.set("url", pageUrl);
  return url.toString();
}
