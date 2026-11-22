// Unit tests with a mocked upstream: routes, allow-list, errors, time formatting and the planner/issue projections.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { clearCache, get, seg, ToolError } from "../src/upstream.ts";
import { time } from "../src/time.ts";
import { parseId } from "../src/cite.ts";
import { issues, planJourneys } from "../src/rail.ts";

const cfg = loadConfig({ TWIN_ORIGIN: "https://twin.test", KTOR_ORIGIN: "https://ktor.test" } as NodeJS.ProcessEnv);
type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
function mock(routes: Record<string, unknown | ((u: URL) => unknown)>) {
  calls = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const u = new URL(url);
    const hit = routes[u.pathname];
    if (hit === undefined) return new Response("{}", { status: 404 });
    const body = typeof hit === "function" ? (hit as (u: URL) => unknown)(u) : hit;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}
beforeEach(() => clearCache());

test("config accepts bare origins only", () => {
  assert.equal(cfg.twin, "https://twin.test");
  assert.throws(() => loadConfig({ TWIN_ORIGIN: "https://twin.test/api" } as NodeJS.ProcessEnv), /bare origin/);
  assert.throws(() => loadConfig({ TWIN_ORIGIN: "https://u:p@twin.test" } as NodeJS.ProcessEnv), /bare origin/);
  assert.throws(() => loadConfig({} as NodeJS.ProcessEnv), /TWIN_ORIGIN is required/);
});

test("identifiers cannot change the route", () => {
  assert.equal(seg("20261122_ojp-91-1-H.1.TA.110.j26"), "20261122_ojp-91-1-H.1.TA.110.j26");
  for (const bad of ["../x", "a/b", "..", "", "x?y=1", "%2F"]) assert.throws(() => seg(bad), ToolError);
  assert.deepEqual(parseId("station:8507000"), { kind: "station", key: "8507000" });
  assert.deepEqual(parseId("network:now"), { kind: "network", key: "now" });
  for (const bad of ["station:850700", "network:x", "foo:1", "train:../x", "journey:a/b"]) assert.throws(() => parseId(bad), ToolError);
});

test("Swiss local time with daylight saving and dates only when not today", () => {
  assert.deepEqual(time(Date.UTC(2026, 10, 22, 10, 0)), { ms: Date.UTC(2026, 10, 22, 10, 0), hm: "11:00" });
  assert.equal(time(Date.UTC(2026, 6, 1, 10, 0))!.hm, "12:00");
  assert.equal(time(Date.UTC(2026, 10, 22, 23, 30), "2026-11-22")!.date, "2026-11-23");
  assert.equal(time(null), null);
});

test("upstream: GET only, fixed origin, no redirects, mapped errors", async () => {
  mock({ "/api/status": { ok: 1 }, "/api/broken": "not json" });
  const r = await get(cfg, "twin", "/status");
  assert.deepEqual(r.data, { ok: 1 });
  assert.equal(calls[0].url, "https://twin.test/api/status");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  await assert.rejects(get(cfg, "twin", "/missing"), (e: ToolError) => e.code === "not_found");
  await assert.rejects(get(cfg, "twin", "/broken"), (e: ToolError) => e.code === "upstream_unavailable");
  await assert.rejects(get(cfg, "twin", "/../control/reset"), (e: ToolError) => e.code === "invalid_input");
  await get(cfg, "ktor", "/trains", { line: "IC1", limit: 2000 }).catch(() => {});
  assert.equal(calls.at(-1)!.url, "https://ktor.test/api/v1/trains?line=IC1&limit=2000");
});

test("planner: the recommended journey is the fastest certain one, and it is always kept", async () => {
  const j = (id: string, arr: number, extra: object = {}) => ({ id, departure: arr - 3600e3, arrival: arr, transfers: 0, legs: [], warnings: [], ...extra });
  const t0 = Date.UTC(2026, 10, 22, 8, 0);
  mock({ "/api/plan": { from: { id: "8507000", name: "Bern" }, to: { id: "8503000", name: "Zürich HB" }, generatedAt: t0,
    journeys: [j("a", t0 + 1e6, { uncertain: true }), j("b", t0 + 2e6), j("c", t0 + 3e6), j("d", t0 + 4e6, { fastest: true })] } });
  const p = await planJourneys(cfg, { fromStopId: "8507000", toStopId: "8503000", limit: 2 });
  assert.equal(p.recommendedJourneyId, "d");
  assert.deepEqual(p.journeys.map((x) => x.journeyId), ["a", "d"]);
  assert.match(calls[0].url, /includeWait=true/);
  await planJourneys(cfg, { fromStopId: "8507000", toStopId: "8503000", viaStopId: "8500218" });
  assert.doesNotMatch(calls.at(-1)!.url, /includeWait/);
});

test("issues: a control incident mirroring a disruption is counted once", async () => {
  mock({
    "/api/disruptions": [{ id: "d-1", summary: "Interrupted service: Olten - Aarau", effect: "interrupted", status: "active", where: "Olten - Aarau" }],
    "/api/alerts": [{ id: "sa-1", title: "Limited service: A - B", severity: "major", stations: [{ name: "A" }], activePeriods: [] }],
    "/api/incidents": [{ id: "d-1", source: "control", title: "Interrupted service: Olten - Aarau" }, { id: "auto-late-1", source: "auto", title: "IC1: 12 min late", severity: "minor" }],
  });
  const r = await issues(cfg, "all");
  assert.deepEqual(r.all.map((x) => `${x.kind}:${x.id}`), ["disruption:d-1", "alert:sa-1", "incident:auto-late-1"]);
  assert.equal(r.counts.incidents, 1);
  assert.equal(r.all[0].severity, "critical");
});
