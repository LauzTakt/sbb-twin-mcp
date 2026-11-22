# sbb-twin-mcp

A **read-only MCP server** for the LauzHack 2026 Swiss rail digital twin ([sbb-twin](https://github.com/lauzhack2026/sbb-twin)):
live trains following SBB realtime data, control-centre disruptions with their bulletins, real SBB service alerts, station
boards and the twin's journey planner. It lets ChatGPT, Claude, Codex or any MCP client answer questions such as *"what is
happening on the network now?"*, *"is the IC 1 735 late?"* or *"what is the fastest way from Bern to Zürich HB right now?"*.

Design by Astra (Codex advisor), implemented and tested against the deployed twin. Agents: read [AGENTS.md](AGENTS.md) and
[skills/read-sbb-twin/SKILL.md](skills/read-sbb-twin/SKILL.md).

## Tools

| Tool | What it answers |
|---|---|
| `twin_status` | Twin clock, trains in service, freshness of the realtime and SBB-alert feeds (`live` or `degraded`) |
| `search` | Ids for station names, train numbers (`IC1 735`), lines, issue keywords, `network` |
| `fetch` | The full text document for one id (`network:now`, `station:<id>`, `train:<id>`, `disruption:<id>`, `alert:<id>`, `incident:<id>`, `journey:<id>`) with a citation URL |
| `list_issues` | Control disruptions, real SBB alerts and incidents, most important first |
| `get_disruption` | One control disruption: cause, section, effect, expected end, measures, bulletin, affected trains |
| `get_train` | One train: delay, position, effective destination, disruption, calls with planned and live times |
| `station_board` | Next departures, or the trains on their way (`view: "arrivals"`) |
| `rail_brief` | Everything at a station or on a route: disruptions, alerts, departures, best journeys |
| `plan_journeys` | A to B on the effective timetable, earliest arrival first; `recommendedJourneyId` = fastest certain option |
| `journey_stops` | Stop-by-stop itinerary of a planned journey, with stops no longer served |

All tools carry `readOnlyHint: true`. Times are `{ ms, hm }` (epoch ms and Swiss local `HH:MM`). `search` and `fetch` follow
the shape ChatGPT deep research and company knowledge expect.

**Safety model.** The server only sends `GET` requests to the two configured origins, on fixed routes; identifiers are
validated as single path segments, redirects are refused, bodies are capped, and nothing writes, calls the paid assistant or
takes a URL from the caller. Host and Origin headers are checked, and requests are rate limited (60/min per client).

## Run

```sh
npm ci && npm run build
export TWIN_ORIGIN=https://<twin-host> KTOR_ORIGIN=https://<backend-host>   # ask the team for the hosts
node dist/cli.js --stdio                              # for local clients
PORT=3333 node dist/cli.js --http                     # Streamable HTTP at http://127.0.0.1:3333/mcp
```

Docker / Coolify: build the `Dockerfile`, set `TWIN_ORIGIN`, `KTOR_ORIGIN` and `PUBLIC_ORIGIN` (the public https URL of the
app), expose port 3333 behind HTTPS. `GET /healthz` is the health check. See [.env.example](.env.example).

## Connect a client

- **ChatGPT (web)**: Plugins → **+** → *Add custom MCP server* → `https://<mcp-host>/mcp`, authentication **None**, create it as
  a plugin, then `@`-mention it in a new chat. Older workspaces: Settings → Apps → Create. Business/Enterprise may need an admin.
  Paste the instructions from [AGENTS.md](AGENTS.md) in the project or GPT.
- **Claude (claude.ai / Desktop)**: Customize → Connectors → *Add custom connector* → `https://<mcp-host>/mcp`, no sign-in.
- **Claude Code**: `claude mcp add --transport http sbb-twin https://<mcp-host>/mcp`, or locally
  `claude mcp add --transport stdio sbb-twin -- node /path/dist/cli.js --stdio` (with `TWIN_ORIGIN` set). Copy
  `skills/read-sbb-twin` into `.claude/skills/` for the skill.
- **Codex**: `codex mcp add sbb-twin --url https://<mcp-host>/mcp`.

Try: *"Check the twin's feed age, then give me the next departures from Bern"* and *"What is the fastest way from Bern to
Zürich HB, where do I change, and does it depend on a reopening?"*.

## Tests

```sh
npm test                                              # unit tests, mocked upstream
npm run smoke -- --http http://127.0.0.1:3333/mcp     # every tool over HTTP against the configured twin (GET only)
npm run smoke -- --stdio                              # the same over stdio
```

Verified on 22 Nov 2026 against the deployed twin: 6/6 unit tests, 25/25 HTTP and 24/24 stdio smoke checks, and a real
Codex CLI agent answering with five MCP calls (`twin_status`, `search` ×2, `station_board`, `plan_journeys`).
