// Runtime configuration from the environment. The upstream origins are the only hosts this server ever calls.
export type Config = {
  twin: string; // sbb-twin origin, e.g. https://twin.example.org (API under /api)
  ktor: string | null; // ktor_app origin (API under /api/v1), used only to resolve public train numbers
  publicOrigin: string; // where this MCP server is reachable, for citation URLs
  port: number;
  host: string;
  allowedOrigins: string[]; // browser Origin headers accepted on /mcp (server-to-server clients send none)
  trustProxy: boolean;
};

function origin(name: string, value: string | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${name} is not a URL: ${v}`);
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash)
    throw new Error(`${name} must be a bare origin such as https://host or http://127.0.0.1:8787 (no path, query or credentials)`);
  return u.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const twin = origin("TWIN_ORIGIN", env.TWIN_ORIGIN);
  if (!twin) throw new Error("TWIN_ORIGIN is required (the sbb-twin deployment, e.g. https://twin.example.org)");
  const port = Number(env.PORT ?? 3333);
  const host = env.HOST ?? "127.0.0.1";
  const publicOrigin = origin("PUBLIC_ORIGIN", env.PUBLIC_ORIGIN) ?? `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  const extra = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    twin,
    ktor: origin("KTOR_ORIGIN", env.KTOR_ORIGIN),
    publicOrigin,
    port,
    host,
    allowedOrigins: [publicOrigin, "https://chatgpt.com", "https://chat.openai.com", "https://claude.ai", ...extra],
    trustProxy: env.TRUST_PROXY === "1",
  };
}
