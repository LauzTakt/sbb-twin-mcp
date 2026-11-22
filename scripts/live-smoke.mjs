// Protocol + live smoke test with the official MCP client: every tool, over HTTP (--http URL) or stdio (--stdio).
// The server only issues GET requests to the configured twin/backend, so this is safe against a live deployment.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const httpUrl = process.argv.includes("--http") ? process.argv[process.argv.indexOf("--http") + 1] : null;
const client = new Client({ name: "sbb-twin-mcp-smoke", version: "1.0.0" });
const transport = httpUrl
  ? new StreamableHTTPClientTransport(new URL(httpUrl))
  : new StdioClientTransport({ command: process.execPath, args: ["dist/cli.js", "--stdio"], env: process.env, stderr: "ignore" });
const rows = [];
const ok = (name, pass, note = "") => rows.push({ name, pass, note: String(note).slice(0, 150) });
const call = async (name, args = {}) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const ms = Date.now() - t0;
  const text = r.content?.[0]?.text ?? "";
  const data = r.structuredContent ?? (() => { try { return JSON.parse(text); } catch { return null; } })();
  return { r, data, ms, isError: !!r.isError, text };
};

await client.connect(transport);
const instr = client.getInstructions() ?? "";
ok("initialize + instructions", instr.includes("Read-only") && instr.length > 400, `${instr.length} chars`);
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
ok("tools/list: 10 tools", tools.length === 10, names.join(","));
ok("all tools read-only annotated", tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false), "");
ok("all tools have output schemas", tools.every((t) => t.outputSchema), "");

const st = await call("twin_status");
ok("twin_status", !st.isError && typeof st.data?.trainsActive === "number", `${st.ms} ms · ${st.data?.freshness} · ${st.data?.trainsActive} trains · rt ${st.data?.realtime?.feedAgeSec}s`);

const s1 = await call("search", { query: "station Bern" });
const bern = s1.data?.results?.find((x) => x.id === "station:8507000");
ok("search station Bern", !!bern, `${s1.ms} ms · ${s1.data?.results?.length} results · ${bern?.url ?? ""}`);
const s2 = await call("search", { query: "Zürich HB" });
const zh = s2.data?.results?.find((x) => x.id === "station:8503000");
ok("search Zürich HB (accents)", !!zh, `${s2.ms} ms · ${s2.data?.results?.map((x) => x.id).slice(0, 3).join(" ")}`);

const dep = await call("station_board", { stopId: "8507000" });
ok("station_board departures", !dep.isError && Array.isArray(dep.data?.rows), `${dep.ms} ms · ${dep.data?.station?.name} · ${dep.data?.rows?.length} rows · first ${dep.data?.rows?.[0]?.planned?.hm ?? "-"} ${dep.data?.rows?.[0]?.line ?? ""}`);
const arr = await call("station_board", { stopId: "8507000", view: "arrivals" });
ok("station_board arrivals", !arr.isError && Array.isArray(arr.data?.rows), `${arr.ms} ms · ${arr.data?.rows?.length} rows`);

const plan = await call("plan_journeys", { fromStopId: "8507000", toStopId: "8503000" });
const j0 = plan.data?.journeys?.[0];
ok("plan_journeys Bern -> Zürich HB", !plan.isError && plan.data?.journeys?.length > 0, `${plan.ms} ms · ${plan.data?.journeys?.length} journeys · rec ${plan.data?.recommendedJourneyId ? "yes" : "none"} · ${j0?.departure?.hm}->${j0?.arrival?.hm} ${j0?.transfers} ch`);
const jid = plan.data?.recommendedJourneyId ?? j0?.journeyId;
if (jid) {
  const js = await call("journey_stops", { journeyId: jid });
  ok("journey_stops", !js.isError && js.data?.calls?.length > 0, `${js.ms} ms · ${js.data?.legs?.length} legs · ${js.data?.calls?.length} calls · next ${js.data?.nextOffset}`);
  const fj = await call("fetch", { id: `journey:${jid}` });
  ok("fetch journey", !fj.isError && fj.data?.text?.includes("Leg 1"), `${fj.ms} ms · ${fj.data?.title}`);
}
const tid = dep.data?.rows?.find((r) => !r.cancelled)?.trainId ?? j0?.legs?.[0]?.trainId;
if (tid) {
  const tr = await call("get_train", { trainId: tid });
  ok("get_train (from the board)", !tr.isError || JSON.parse(tr.text).code === "not_in_service", tr.isError ? `not in service yet (${JSON.parse(tr.text).code})` : `${tr.ms} ms · ${tr.data?.line} to ${tr.data?.destination?.name} · ${tr.data?.calls?.length} calls`);
}
const iss = await call("list_issues", { limit: 5 });
ok("list_issues", !iss.isError && iss.data?.counts, `${iss.ms} ms · ${JSON.stringify(iss.data?.counts)} · unavailable ${iss.data?.unavailableSources?.length}`);
const dis = iss.data?.items?.find((x) => x.kind === "disruption");
if (dis) {
  const gd = await call("get_disruption", { disruptionId: dis.id });
  ok("get_disruption", !gd.isError && gd.data?.bulletin, `${gd.ms} ms · ${gd.data?.bulletin?.title}`);
} else {
  const gd = await call("get_disruption", { disruptionId: "d-does-not-exist" });
  ok("get_disruption (none active: error path)", gd.isError && JSON.parse(gd.text).code === "not_found", gd.text);
}
const alert = iss.data?.items?.find((x) => x.kind === "alert" || x.kind === "incident");
if (alert) {
  const fa = await call("fetch", { id: `${alert.kind}:${alert.id}` });
  ok(`fetch ${alert.kind}`, !fa.isError && fa.data?.text?.length > 20, `${fa.ms} ms · ${fa.data?.title}`);
}
const rb = await call("rail_brief", { fromStopId: "8507000" });
ok("rail_brief station", !rb.isError && rb.data?.from?.name === "Bern", `${rb.ms} ms · ${rb.data?.disruptions?.length} disruptions · ${rb.data?.alerts?.length} alerts · ${rb.data?.departures?.length} departures`);
const rr = await call("rail_brief", { fromStopId: "8507000", toStopId: "8503000" });
ok("rail_brief route", !rr.isError && rr.data?.to?.name, `${rr.ms} ms · ${rr.data?.journeys?.length} journeys`);
const sn = await call("search", { query: "network" });
ok("search network", sn.data?.results?.[0]?.id === "network:now", `${sn.ms} ms · ${sn.data?.results?.length} results`);
const fn = await call("fetch", { id: "network:now" });
ok("fetch network:now", !fn.isError && fn.data?.text?.includes("trains in service"), `${fn.ms} ms · ${fn.data?.text?.split("\n")[2]}`);
const fs = await call("fetch", { id: "station:8507000" });
ok("fetch station", !fs.isError && fs.data?.title?.startsWith("Bern"), `${fs.ms} ms`);
const tn = await call("search", { query: "IC1" });
ok("search line IC1 (backend)", !tn.isError, `${tn.ms} ms · ${tn.data?.results?.length} results · ${tn.data?.results?.[0]?.title ?? "none in service"}`);
// rejected inputs
const bad1 = await call("fetch", { id: "station:../x" });
ok("rejects a bad id", bad1.isError && JSON.parse(bad1.text).code === "invalid_input", bad1.text);
let bad2;
try { bad2 = await call("station_board", { stopId: "../../control/reset" }); } catch (e) { bad2 = { isError: true, text: String(e.message) }; }
ok("rejects a bad stopId (schema)", bad2.isError, bad2.text);
if (httpUrl && bern) {
  const c = await fetch(bern.url);
  const body = await c.text();
  ok("citation URL opens", c.status === 200 && body.startsWith("Bern"), `${c.status} · ${body.split("\n")[0]}`);
}
await client.close();
const fails = rows.filter((r) => !r.pass);
for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(36)} ${r.note}`);
console.log(`\n${rows.length - fails.length}/${rows.length} passed (${httpUrl ? "HTTP " + httpUrl : "stdio"})`);
process.exit(fails.length ? 1 : 0);
