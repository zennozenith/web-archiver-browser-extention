import { reqwest, type TestEndpointResponse } from "./reqwest";
import type { HealthResponse, Stats } from "@common/api-types";
import { createUrl } from "@common/index";

function formatCount(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

/** `GET /api/health` — lightweight liveness check. */
export async function testHealth(serverUrl: URL, token?: string): Promise<TestEndpointResponse> {
  const [res, error] = await reqwest<HealthResponse>(createUrl(serverUrl, "/api/health"), {
    token,
    timeoutMs: 20000,
  });

  if (error) {
    return { ok: false, text: `health ✗ ${error.detail}` };
  }

  return { ok: true, text: `health ✓ ${res.status}` };
}

/** `GET /api/stats` — totals and deduplication savings. */
export async function testStats(serverUrl: URL, token?: string): Promise<TestEndpointResponse> {
  const [res, error] = await reqwest<Stats>(createUrl(serverUrl, "/api/stats"), {
    token,
    timeoutMs: 20000,
  });

  if (error) {
    return { ok: false, text: `stats ✗ ${error.detail}` };
  }

  const counts = [
    ["pages", formatCount(res.pages)],
    ["captures", formatCount(res.captures)],
    ["tags", formatCount(res.tags)],
    ["queued", formatCount(res.queue?.queued)],
  ]
    .filter(([, value]) => value !== null)
    .map(([label, value]) => `${label}: ${value}`);

  return {
    ok: true,
    text: `stats ✓${counts.length ? ` (${counts.join(", ")})` : ""}`,
  };
}
