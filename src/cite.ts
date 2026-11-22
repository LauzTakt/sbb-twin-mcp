// search / fetch (the citation pair ChatGPT deep research and company knowledge use) and the plain-text documents
// behind every citation URL (/r/<kind>/<key>).
import type { Config } from "./config.ts";
import { get, ToolError } from "./upstream.ts";
import { getDisruption, getTrain, issues, journeyStops, listIssues, railBrief, searchStations, twinStatus } from "./rail.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
export const KINDS = ["network", "station", "train", "disruption", "incident", "alert", "journey"] as const;
export type Kind = (typeof KINDS)[number];
const KEY = /^[A-Za-z0-9_][A-Za-z0-9._:~-]{0,159}$/;
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function parseId(id: string): { kind: Kind; key: string } {
  const m = /^([a-z]+):(.+)$/.exec(id.trim());
  if (!m || !(KINDS as readonly string[]).includes(m[1])) throw new ToolError("invalid_input", `Unknown id "${id}". Ids look like station:8507000, train:<trainId>, disruption:<id>, alert:<id>, incident:<id>, journey:<id> or network:now; get them from search.`);
  const kind = m[1] as Kind;
  const key = m[2];
  if (kind === "network" ? key !== "now" : !KEY.test(key) || key.includes("..") || (kind === "station" && !/^\d{7}$/.test(key)))
    throw new ToolError("invalid_input", `Invalid id "${id}".`);
  return { kind, key };
}

export const citeUrl = (cfg: Config, kind: Kind, key: string) => `${cfg.publicOrigin}/r/${kind}/${encodeURIComponent(key)}`;
type Result = { id: string; title: string; url: string };
const result = (cfg: Config, kind: Kind, key: string, title: string): Result => ({ id: `${kind}:${key}`, title, url: citeUrl(cfg, kind, key) });

async function trainsByNumber(cfg: Config, line: string | null, number: string | null): Promise<Any[]> {
  if (!cfg.ktor) return [];
  const { data } = await get<Any>(cfg, "ktor", "/trains", { ...(line ? { line } : {}), limit: 2000 }, 15000, 4000);
  const items: Any[] = data?.items ?? [];
  return items.filter((t) => (number ? String(t.number) === number : true));
}

export async function search(cfg: Config, query: string): Promise<{ results: Result[] }> {
  const q = query.trim().slice(0, 160);
  if (!q) throw new ToolError("invalid_input", "Empty query.");
  const out: Result[] = [];
  const add = (r: Result) => {
    if (out.length < 10 && !out.some((x) => x.id === r.id)) out.push(r);
  };
  // an exact typed id
  if (/^[a-z]+:/.test(q)) {
    const { kind, key } = parseId(q);
    add(result(cfg, kind, key, kind === "network" ? "Swiss rail network now" : `${kind} ${key}`));
    return { results: out };
  }
  const f = fold(q);
  // the network
  if (/^(network|now|status|disruptions?|alerts?|issues?|incidents?)\b/.test(f)) {
    add(result(cfg, "network", "now", "Swiss rail network now: status and active issues"));
    const kind = f.startsWith("disruption") ? "disruption" : f.startsWith("alert") ? "alert" : f.startsWith("incident") ? "incident" : "all";
    const r = await listIssues(cfg, kind, 0, 9);
    for (const i of r.items) add(result(cfg, i.kind, i.id, `${i.title}${i.where ? ` (${i.where})` : ""}`));
    return { results: out };
  }
  // stations only
  const st = /^station\s+(.+)$/i.exec(q);
  if (st) {
    for (const s of await searchStations(cfg, st[1], 10)) add(result(cfg, "station", s.stopId, `${s.name} (station ${s.stopId})`));
    return { results: out };
  }
  // a public train number, optionally with its line: "IC1 735", "735", "IR 16 2533"
  const tn = /^(?:([A-Za-z]{1,4})\s?(\d{0,3})\s+)?(\d{2,5})$/.exec(q);
  const lineOnly = /^([A-Za-z]{1,4})\s?(\d{1,3})$/.exec(q);
  if (tn || lineOnly) {
    try {
      const line = tn ? (tn[1] ? `${tn[1]}${tn[2] ?? ""}`.toUpperCase() : null) : `${lineOnly![1]}${lineOnly![2]}`.toUpperCase();
      const trains = await trainsByNumber(cfg, line, tn ? tn[3] : null);
      for (const t of trains.slice(0, 10))
        add(result(cfg, "train", String(t.trainId), `${t.line ?? t.category ?? ""} ${t.number ?? ""} to ${t.destination?.name ?? t.headsign ?? "?"}${t.currentStop?.name ? `, now at ${t.currentStop.name}` : ""} (${t.trainId})`.trim()));
      if (out.length) return { results: out };
    } catch {
      /* fall through to stations */
    }
  }
  // stations and issues by text
  const [stations, iss] = await Promise.allSettled([searchStations(cfg, q, 6), issues(cfg, "all")]);
  if (stations.status === "fulfilled") for (const s of stations.value) add(result(cfg, "station", s.stopId, `${s.name} (station ${s.stopId})`));
  if (iss.status === "fulfilled")
    for (const i of iss.value.all.filter((i) => fold(`${i.title} ${i.where ?? ""}`).includes(f)).slice(0, 4)) add(result(cfg, i.kind, i.id, `${i.title}${i.where ? ` (${i.where})` : ""}`));
  return { results: out };
}

// ------------------------------------------------------------------ documents
const t = (x: Any) => (x ? `${x.hm}${x.date ? ` (${x.date})` : ""}` : "–");
const late = (min: number) => (min > 0 ? ` +${min} min` : "");

export async function fetchDoc(cfg: Config, id: string): Promise<{ id: string; title: string; text: string; url: string; metadata: { source: string; kind: Kind; asOfMs: number } }> {
  const { kind, key } = parseId(id);
  const url = citeUrl(cfg, kind, key);
  const doc = (title: string, lines: (string | null | undefined | false)[], asOfMs: number) => ({
    id: `${kind}:${key}`, title, url, text: [title, "", ...lines.filter((l): l is string => typeof l === "string")].join("\n"), metadata: { source: "sbb-twin (LauzHack 2026 digital twin)", kind, asOfMs },
  });
  switch (kind) {
    case "network": {
      const [s, i] = await Promise.all([twinStatus(cfg), listIssues(cfg, "all", 0, 12)]);
      return doc("Swiss rail network now", [
        `Twin time ${t(s.twinTime)} on ${s.localDate}; data ${s.freshness}${s.problems.length ? ` (${s.problems.join("; ")})` : ""}.`,
        `${s.trainsActive ?? "?"} trains in service; realtime feed ${s.realtime.enabled ? `${s.realtime.feedAgeSec ?? "?"} s old` : "off"}; SBB alerts feed ${s.alerts.enabled ? `${s.alerts.feedAgeSec ?? "?"} s old` : "off"}.`,
        `Control disruptions: ${i.counts.disruptions ?? "unknown"}; SBB alerts: ${i.counts.alerts ?? "unknown"} (${i.counts.alertsActiveNow ?? "?"} active now); incidents: ${i.counts.incidents ?? "unknown"}.`,
        "",
        ...i.items.map((x) => `- [${x.kind}${x.source !== x.kind ? `, ${x.source}` : ""}${x.severity ? `, ${x.severity}` : ""}] ${x.title}${x.where ? ` (${x.where})` : ""} — id ${x.kind}:${x.id}`),
      ], s.asOfMs);
    }
    case "station": {
      const b = await railBrief(cfg, key);
      return doc(`${b.from?.name ?? key} (station ${key})`, [
        b.disruptions.length ? "Control-centre disruptions:" : "No control-centre disruption here.",
        ...b.disruptions.map((d: Any) => `- ${d.title}${d.expectedEnd ? `, expected end ${t(d.expectedEnd)}${d.durationType === "UNTIL_AT_LEAST" ? " at the earliest" : ""}` : ""}\n  ${String(d.description ?? "").replace(/\n/g, "\n  ")}`),
        b.alerts.length ? "Real SBB alerts:" : null,
        ...b.alerts.map((a: Any) => `- ${a.title}${a.description ? `: ${a.description}` : ""}`),
        "",
        "Next departures:",
        ...b.departures.map((d: Any) => `- ${t(d.planned)}${d.cancelled ? " CANCELLED" : late(d.delayMin)} ${d.line ?? d.category} to ${d.headsign}`),
      ], b.asOfMs);
    }
    case "train": {
      const r = await getTrain(cfg, key, undefined, 30);
      return doc(`${r.line ?? r.category ?? "Train"} ${r.number ?? ""} to ${r.destination?.name ?? "?"}`.replace(/\s+/g, " "), [
        `Train ${r.trainId}: ${r.status ?? "?"}, ${r.delaySec != null ? `${Math.round(r.delaySec / 60)} min late` : "delay unknown"}${r.disruptionId ? `, affected by disruption ${r.disruptionId}` : ""}.`,
        r.plannedDestination ? `Ends at ${r.destination?.name} instead of ${r.plannedDestination.name}.` : null,
        `Position: ${r.atStop ? `at ${r.atStop.name}` : r.prevStop && r.nextStop ? `between ${r.prevStop.name} and ${r.nextStop.name}` : "unknown"} (${r.position.motion ?? "?"}, ${r.position.speedKmh ?? "?"} km/h, as of ${t(r.position.ts)}).`,
        "",
        "Calls:",
        ...r.calls.map((c) => `- ${c.name}: arr ${t(c.expectedArr ?? c.plannedArr)} dep ${t(c.expectedDep ?? c.plannedDep)}${c.cancelled ? " CANCELLED" : c.skipped ? " SKIPPED" : ""}`),
      ], r.asOfMs);
    }
    case "disruption": {
      const d = await getDisruption(cfg, key, 0, 30);
      return doc(d.bulletin?.title ?? `Disruption ${key}`, [
        `${d.effect ?? "?"} · ${d.cause?.label ?? ""} · ${d.where ?? ""} · status ${d.status}. Expected end ${t(d.expectedEnd)}${d.durationType === "UNTIL_AT_LEAST" ? " (at the earliest)" : d.durationType === "UNKNOWN" ? " (unknown)" : ""}.`,
        d.bulletin ? `Bulletin v${d.bulletin.version} (${d.bulletin.source}, ${t(d.bulletin.ts)}):\n${d.bulletin.description}` : null,
        ...(d.bulletin?.messages ?? []).map((m: Any) => `- ${t(m.ts)} ${m.title}: ${m.text}`),
        d.measures.length ? `Measures: ${d.measures.map((m: Any) => `${m.label} (${m.status ?? "?"})`).join("; ")}.` : null,
        d.impact ? `Impact: ${JSON.stringify(d.impact)}.` : null,
        `${d.affectedTrainCount} trains affected so far.`,
      ], d.asOfMs);
    }
    case "alert":
    case "incident": {
      const r = await issues(cfg, kind);
      const raw = (kind === "alert" ? r.raw.alerts : r.raw.incidents).find((x: Any) => String(x.id) === key);
      if (!raw) throw new ToolError("not_found", `No current ${kind} ${key}; it may have ended. Use list_issues.`);
      const periods = (raw.activePeriods ?? []).map((p: Any) => `${p.start ? new Date(p.start).toISOString() : "?"} – ${p.end ? new Date(p.end).toISOString() : "open"}`);
      return doc(String(raw.title ?? `${kind} ${key}`), [
        `${kind === "alert" ? "Real SBB service alert" : `Incident (${raw.source ?? "staff"})`}${raw.severity ? `, severity ${raw.severity}` : ""}${raw.status ? `, status ${raw.status}` : ""}.`,
        raw.where ? `Where: ${raw.where}.` : raw.stations?.length ? `Stations: ${raw.stations.map((s: Any) => s.name).join(", ")}.` : null,
        raw.description ? String(raw.description) : null,
        periods.length ? `Active periods (UTC): ${periods.join("; ")}.` : null,
      ], raw.updatedAt ?? Date.now());
    }
    case "journey": {
      const j = await journeyStops(cfg, key, 0, 200);
      const lines: string[] = [`Departure ${t(j.departure)}, arrival ${t(j.arrival)}, ${j.transfers ?? "?"} change(s)${j.fastest ? ", the fastest certain option" : ""}${j.uncertain ? ", depends on a reopening that is not confirmed" : ""}.`];
      for (const l of j.legs) {
        lines.push("", `Leg ${l.legIndex + 1}: ${l.line ?? l.category} towards ${l.headsign ?? "?"}, ${l.from?.name} → ${l.to?.name} (train ${l.trainId})`);
        for (const c of j.calls.filter((c: Any) => c.legIndex === l.legIndex)) lines.push(`  - ${c.name}: arr ${t(c.expectedArr)} dep ${t(c.expectedDep)}${c.served ? "" : " NOT SERVED"}`);
      }
      return doc(`Journey ${j.legs[0]?.from?.name ?? ""} → ${j.legs[j.legs.length - 1]?.to?.name ?? ""}`, lines, j.asOfMs);
    }
  }
}
