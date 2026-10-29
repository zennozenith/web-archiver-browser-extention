import { reqwest, type TestEndpointResponse } from "./reqwest";
import { createUrl } from "@common/index";

/** `GET /api/health` — lightweight liveness check. */
export interface HealthResponse {
  status?: string;
  urls?: number;
  versions?: number;
  pending?: number;
  [key: string]: unknown;
}

/** `GET /api/stats` — totals and deduplication savings. */
export interface StatsResponse {
  [key: string]: unknown;
}

function formatCount(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

export async function testHealth(serverUrl: URL, token?: string): Promise<TestEndpointResponse> {
  const [res, error] = await reqwest<HealthResponse>(createUrl(serverUrl, "/api/health"), {
    token,
    timeoutMs: 20000,
  });

  if (error) {
    return { ok: false, text: `health ✗ ${error.detail}` };
  }

  const counts = [
    ["urls", formatCount(res.urls)],
    ["versions", formatCount(res.versions)],
    ["pending", formatCount(res.pending)],
  ]
    .filter(([, value]) => value !== null)
    .map(([label, value]) => `${label}: ${value}`);

  const status = typeof res.status === "string" ? res.status : "online";
  return {
    ok: true,
    text: `health ✓ ${status}${counts.length ? ` (${counts.join(", ")})` : ""}`,
  };
}

export async function testStats(serverUrl: URL, token?: string): Promise<TestEndpointResponse> {
  const [res, error] = await reqwest<StatsResponse>(createUrl(serverUrl, "/api/stats"), {
    token,
    timeoutMs: 20000,
  });

  if (error) {
    return { ok: false, text: `stats ✗ ${error.detail}` };
  }

  const counts = [
    ["pages", formatCount(res.pages ?? res.urls)],
    ["captures", formatCount(res.captures ?? res.versions)],
    ["pending", formatCount(res.pending)],
    ["content", formatCount(res.content ?? res.blobs)],
  ]
    .filter(([, value]) => value !== null)
    .map(([label, value]) => `${label}: ${value}`);

  return {
    ok: true,
    text: `stats ✓${counts.length ? ` (${counts.join(", ")})` : ""}`,
  };
}
