// Streamable HTTP at /mcp (stateless, JSON responses), a health check, and the citation documents at /r/<kind>/<key>.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { Config } from "./config.ts";
import { makeServer } from "./server.ts";
import { fetchDoc, KINDS } from "./cite.ts";
import { ToolError } from "./upstream.ts";

const buckets = new Map<string, { tokens: number; at: number }>();
let global = { tokens: 240, at: Date.now() };
function take(b: { tokens: number; at: number }, perMin: number) {
  const now = Date.now();
  b.tokens = Math.min(perMin, b.tokens + ((now - b.at) / 60000) * perMin);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

export function startHttp(cfg: Config) {
  const mcp = toNodeHandler(createMcpHandler(() => makeServer(cfg), { responseMode: "json" }));
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]", new URL(cfg.publicOrigin).hostname]);
  const clientIp = (req: IncomingMessage) => (cfg.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "") || req.socket.remoteAddress || "?";

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: string, type = "application/json") => {
      res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
      res.end(body);
    };
    // DNS-rebinding guard: only our own host names
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
    if (!hosts.has(host)) return send(403, JSON.stringify({ error: "Host not allowed" }));
    const origin = req.headers.origin;
    if (origin && !cfg.allowedOrigins.includes(origin) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return send(403, JSON.stringify({ error: "Origin not allowed" }));
    if (origin) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
      res.setHeader("access-control-allow-headers", "content-type, accept, mcp-protocol-version, mcp-session-id, authorization");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.setHeader("access-control-expose-headers", "mcp-session-id, mcp-protocol-version");
    }
    if (req.method === "OPTIONS") return send(204, "");
    if (url.pathname === "/healthz") return send(200, JSON.stringify({ ok: true }));
    if (url.pathname === "/" && req.method === "GET")
      return send(200, `sbb-twin-mcp: a read-only MCP server for the LauzHack 2026 Swiss rail twin.\nMCP endpoint: ${cfg.publicOrigin}/mcp (Streamable HTTP, no authentication).\n`, "text/plain");
    const ip = clientIp(req);
    const bucket = buckets.get(ip) ?? (buckets.set(ip, { tokens: 60, at: Date.now() }), buckets.get(ip)!);
    if (!take(bucket, 60) || !take(global, 240)) {
      res.setHeader("retry-after", "10");
      return send(429, JSON.stringify({ code: "rate_limited", message: "Too many requests; retry in 10 s.", retryable: true, retryAfterSec: 10 }));
    }
    const cite = /^\/r\/([a-z]+)\/([^/]+)$/.exec(url.pathname);
    if (cite && req.method === "GET") {
      if (!(KINDS as readonly string[]).includes(cite[1])) return send(404, "Not found", "text/plain");
      try {
        const doc = await fetchDoc(cfg, `${cite[1]}:${decodeURIComponent(cite[2])}`);
        return send(200, `${doc.text}\n\nAs of ${new Date(doc.metadata.asOfMs).toISOString()} · ${doc.metadata.source}\n`, "text/plain");
      } catch (e) {
        const code = e instanceof ToolError ? e.code : "internal_error";
        return send(code === "not_found" || code === "not_in_service" || code === "invalid_input" ? 404 : code === "journey_expired" ? 410 : 502, e instanceof ToolError ? e.message : "Error", "text/plain");
      }
    }
    if (url.pathname === "/mcp") return void mcp(req, res);
    return send(404, JSON.stringify({ error: "Not found" }));
  });
  server.listen(cfg.port, cfg.host, () => console.error(`[sbb-twin-mcp] MCP on ${cfg.publicOrigin}/mcp (listening on ${cfg.host}:${cfg.port}; twin ${cfg.twin}; backend ${cfg.ktor ?? "not configured"})`));
  return server;
}
