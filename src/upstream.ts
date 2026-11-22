// The only network access of this server: GET requests to the two configured origins, on fixed routes.
// No redirects, a timeout, a body size cap, a short cache and coalescing of identical in-flight requests.
import type { Config } from "./config.ts";

export class ToolError extends Error {
  constructor(public code: string, message: string, public retryable = false, public retryAfterSec?: number) {
    super(message);
  }
}

type Source = "twin" | "ktor";
type Entry = { at: number; expires: number; value: unknown };
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<{ data: unknown; at: number }>>();
const MAX_ENTRIES = 256;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT = 8;
let active = 0;
const waiting: (() => void)[] = [];

/** One path segment from an identifier, rejecting anything that could change the route. */
export function seg(id: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._:~-]{0,159}$/.test(id) || id.includes("..")) throw new ToolError("invalid_input", `Invalid identifier: ${id}`);
  return encodeURIComponent(id);
}

async function slot() {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((ok) => waiting.push(ok));
  active++;
}
function release() {
  active--;
  waiting.shift()?.();
}

export type Query = Record<string, string | number | boolean | undefined>;

export async function get<T = unknown>(cfg: Config, source: Source, path: string, query: Query = {}, ttlMs = 5000, timeoutMs = 3000): Promise<{ data: T; at: number }> {
  const base = source === "twin" ? `${cfg.twin}/api` : cfg.ktor ? `${cfg.ktor}/api/v1` : null;
  if (!base) throw new ToolError("upstream_unavailable", "The backend (KTOR_ORIGIN) is not configured on this server.");
  if (!/^\/[A-Za-z0-9/._~%:-]*$/.test(path) || path.includes("..")) throw new ToolError("invalid_input", "Invalid route");
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") params.set(k, String(v));
  const qs = params.toString();
  const url = `${base}${path}${qs ? `?${qs}` : ""}`;
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && hit.expires > now) return { data: hit.value as T, at: hit.at };
  const running = inflight.get(url);
  if (running) return (await running) as { data: T; at: number };
  const p = (async () => {
    await slot();
    try {
      let res: Response;
      try {
        res = await fetch(url, { method: "GET", redirect: "error", headers: { accept: "application/json", "user-agent": "sbb-twin-mcp/0.1" }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        const name = (e as Error).name;
        if (name === "TimeoutError" || name === "AbortError") throw new ToolError("upstream_timeout", `The ${source} did not answer within ${timeoutMs / 1000} s. Try again.`, true, 5);
        throw new ToolError("upstream_unavailable", `The ${source} is not reachable right now.`, true, 10);
      }
      if (res.status === 404) throw new ToolError("not_found", "Not found.");
      if (!res.ok) throw new ToolError("upstream_unavailable", `The ${source} answered HTTP ${res.status}.`, true, 10);
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) {
            await reader.cancel();
            throw new ToolError("upstream_unavailable", "The upstream response is too large.");
          }
          chunks.push(value);
        }
      const text = Buffer.concat(chunks).toString("utf8");
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new ToolError("upstream_unavailable", `The ${source} sent something that is not JSON.`, true, 10);
      }
      const at = Date.now();
      if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
      cache.set(url, { at, expires: at + ttlMs, value: data });
      return { data, at };
    } finally {
      release();
    }
  })();
  inflight.set(url, p);
  try {
    return (await p) as { data: T; at: number };
  } finally {
    inflight.delete(url);
  }
}

/** For tests. */
export function clearCache() {
  cache.clear();
}
