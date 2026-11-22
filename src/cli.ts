#!/usr/bin/env node
// sbb-twin-mcp: stdio by default (for local clients), --http for the Streamable HTTP endpoint at /mcp.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.ts";
import { makeServer } from "./server.ts";
import { startHttp } from "./http.ts";

const cfg = loadConfig();
if (process.argv.includes("--http")) startHttp(cfg);
else serveStdio(() => makeServer(cfg));
