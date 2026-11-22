// Projections of the twin's data for agents (compact, Swiss local times) and plain-text renderings for citations.
import type { Config } from "./config.ts";
import { get, seg, ToolError } from "./upstream.ts";
import { time, ymd } from "./time.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const SEV: Record<string, number> = { critical: 0, major: 1, minor: 2, info: 3 };
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const place = (p: Any) => (p ? { stopId: String(p.id ?? p.stopId ?? ""), name: String(p.name ?? "") } : null);
const env = (asOfMs: number, basis?: "retrieved") => ({ asOfMs, localDate: ymd(asOfMs), ...(basis ? { timeBasis: basis } : {}) });
const page = <T>(xs: T[], offset: number, limit: number) => ({ items: xs.slice(offset, offset + limit), nextOffset: offset + limit < xs.length ? offset + limit : null });

// ------------------------------------------------------------------ status
export async function twinStatus(cfg: Config) {
  const { data: s, at } = await get<Any>(cfg, "twin", "/status", {}, 5000);
  const ts = typeof s.ts === "number" ? s.ts : at;
  const clockOffsetSec = Math.round((Date.now() - ts) / 1000);
  const rt = s.realtime ?? {};
  const al = s.alerts ?? {};
  const problems: string[] = [];
  if (!rt.enabled) problems.push("realtime feed disabled (timetable only)");
  else if (rt.error) problems.push(`realtime feed error: ${rt.error}`);
  else if (typeof rt.feedAgeSec !== "number" || rt.feedAgeSec > 60) problems.push(`realtime feed is ${rt.feedAgeSec ?? "?"} s old`);
  if (al.enabled && (al.error || (typeof al.feedAgeSec === "number" && al.feedAgeSec > 360))) problems.push("SBB alerts feed is stale or failing");
  if (Math.abs(clockOffsetSec) > 120) problems.push(`twin clock differs from now by ${clockOffsetSec} s (replay or stale snapshot)`);
  return {
    ...env(ts),
    twinTime: time(ts),
    freshness: problems.length ? "degraded" : "live",
    problems,
    timetableDate: s.timetableDate ?? null,
    trainsActive: s.trainsActive ?? null,
    trainsSimulated: s.trainsSimulated ?? null,
    disruptionsActive: s.disruptionsActive ?? null,
    incidentsMarked: s.incidentsMarked ?? null,
    realtime: { enabled: !!rt.enabled, feedAgeSec: rt.feedAgeSec ?? null, trips: rt.trips ?? null, hasError: !!rt.error },
    alerts: { enabled: !!al.enabled, feedAgeSec: al.feedAgeSec ?? null, active: al.active ?? null, hasError: !!al.error },
  };
}

// ------------------------------------------------------------------ issues
export type Issue = { id: string; kind: "disruption" | "alert" | "incident"; source: string; title: string; where: string | null; status: string; severity?: string; activeNow?: boolean; updatedAt?: number };

function alertActive(a: Any, now: number) {
  const ps: Any[] = a.activePeriods ?? [];
  if (!ps.length) return true;
  return ps.some((p) => (p.start == null || p.start <= now) && (p.end == null || p.end >= now));
}

export async function issues(cfg: Config, kind: "all" | "disruption" | "alert" | "incident" = "all") {
  const want = (k: string) => kind === "all" || kind === k;
  const [d, a, i] = await Promise.allSettled([
    want("disruption") || want("incident") ? get<Any[]>(cfg, "twin", "/disruptions", {}, 15000) : Promise.resolve({ data: [], at: Date.now() }),
    want("alert") ? get<Any[]>(cfg, "twin", "/alerts", {}, 15000) : Promise.resolve({ data: [], at: Date.now() }),
    want("incident") ? get<Any[]>(cfg, "twin", "/incidents", {}, 15000) : Promise.resolve({ data: [], at: Date.now() }),
  ]);
  const unavailableSources: string[] = [];
  const val = (r: PromiseSettledResult<{ data: Any[]; at: number }>, name: string) => (r.status === "fulfilled" ? r.value.data : (unavailableSources.push(name), null));
  const ds = val(d, "disruptions");
  const as = val(a, "alerts");
  const is = val(i, "incidents");
  const now = Date.now();
  const out: Issue[] = [];
  const dIds = new Set<string>();
  if (want("disruption"))
    for (const x of ds ?? []) {
      dIds.add(String(x.id));
      out.push({ id: String(x.id), kind: "disruption", source: "control", title: String(x.summary ?? x.label ?? x.id), where: x.where ?? null, status: String(x.status ?? "active"),
        severity: x.effect === "interrupted" ? "critical" : x.effect === "limited" ? "major" : "info", updatedAt: x.updatedAt ?? x.startedAt });
    }
  else for (const x of ds ?? []) dIds.add(String(x.id));
  if (want("alert"))
    for (const x of as ?? []) {
      const names = (x.stations ?? []).map((s: Any) => s.name).filter(Boolean);
      out.push({ id: String(x.id), kind: "alert", source: "sbb", title: String(x.title ?? ""), where: names.length ? names.slice(0, 4).join(", ") + (names.length > 4 ? ", …" : "") : null,
        status: alertActive(x, now) ? "active" : "scheduled", severity: x.severity, activeNow: alertActive(x, now), updatedAt: x.updatedAt });
    }
  if (want("incident"))
    for (const x of is ?? []) {
      if (x.source === "control" && (dIds.has(String(x.id)) || dIds.has(String(x.disruptionId)))) continue; // the disruption itself
      out.push({ id: String(x.id), kind: "incident", source: String(x.source ?? "staff"), title: String(x.title ?? ""), where: x.where ?? null, status: String(x.status ?? "active"), severity: x.severity, updatedAt: x.updatedAt });
    }
  const order = { disruption: 0, alert: 1, incident: 2 };
  out.sort((x, y) => order[x.kind] - order[y.kind] || (y.activeNow === false ? -1 : 0) - (x.activeNow === false ? -1 : 0) || (SEV[x.severity ?? "info"] ?? 3) - (SEV[y.severity ?? "info"] ?? 3) || (y.updatedAt ?? 0) - (x.updatedAt ?? 0));
  const counts = {
    disruptions: ds ? out.filter((x) => x.kind === "disruption").length : null,
    alerts: as ? out.filter((x) => x.kind === "alert").length : null,
    alertsActiveNow: as ? out.filter((x) => x.kind === "alert" && x.activeNow).length : null,
    incidents: is ? out.filter((x) => x.kind === "incident").length : null,
  };
  return { all: out, counts, unavailableSources, raw: { alerts: as ?? [], incidents: is ?? [] } };
}

export async function listIssues(cfg: Config, kind: "all" | "disruption" | "alert" | "incident", offset: number, limit: number) {
  const r = await issues(cfg, kind);
  const p = page(r.all, offset, limit);
  return { ...env(Date.now(), "retrieved"), counts: r.counts, items: p.items, nextOffset: p.nextOffset, unavailableSources: r.unavailableSources };
}

// ------------------------------------------------------------------ disruption
export async function getDisruption(cfg: Config, id: string, offset = 0, limit = 10) {
  let r;
  try {
    r = await get<Any>(cfg, "twin", `/disruptions/${seg(id)}`, {}, 5000);
  } catch (e) {
    if (e instanceof ToolError && e.code === "not_found") throw new ToolError("not_found", `No disruption ${id}. Use list_issues to see the current ones.`);
    throw e;
  }
  const d = r.data;
  const ref = ymd(r.at);
  const b = d.bulletin ?? null;
  const affected: string[] = Array.isArray(d.affectedTrains) ? d.affectedTrains.map(String) : [];
  const p = page(affected, offset, limit);
  const interrupted = (d.effect ?? b?.effect) === "interrupted";
  return {
    ...env(r.at),
    id: String(d.id),
    type: d.kind ?? d.type ?? null,
    status: d.status ?? null,
    cause: d.cause ?? (d.label ? { label: d.label } : null),
    where: d.where ?? null,
    section: d.section ? { a: d.section.a ?? null, b: d.section.b ?? null } : null,
    effect: d.effect ?? null,
    durationType: d.durationType ?? null,
    until: time(d.until, ref),
    expectedEnd: time(d.expectedEnd ?? d.endsAt, ref),
    lines: interrupted ? (b?.lines ?? d.lines ?? []) : [],
    measures: (d.measures ?? []).map((m: Any) => ({ type: m.type, label: m.label ?? m.type, status: m.status ?? m.state ?? null, at: time(m.at, ref), withdrawAt: time(m.withdrawAt, ref) })),
    impact: d.impact ?? null,
    affectedTrainCount: affected.length,
    affectedTrainIds: p.items,
    nextOffset: p.nextOffset,
    bulletin: b ? { title: b.title, description: b.description, version: b.version, ts: time(b.ts, ref), lang: b.lang, source: b.source ?? "template", messages: (b.messages ?? []).map((m: Any) => ({ ts: time(m.ts, ref), title: m.title, text: m.text })) } : null,
  };
}

// ------------------------------------------------------------------ train
export async function getTrain(cfg: Config, trainId: string, offset?: number, limit = 8) {
  let r;
  try {
    r = await get<Any>(cfg, "twin", `/trains/${seg(trainId)}`, {}, 5000);
  } catch (e) {
    if (e instanceof ToolError && e.code === "not_found")
      throw new ToolError("not_in_service", `Train ${trainId} is not in service right now (it may not have started yet, or it has ended). Check a station_board or a journey leg for future departures.`);
    throw e;
  }
  const { position: pos = {}, info = {} } = r.data ?? {};
  const asOf = typeof pos.ts === "number" ? pos.ts : r.at;
  const ref = ymd(asOf);
  const calls: Any[] = info.calls ?? [];
  // by default start at the stop the train is at or last passed, so the next calls come first
  const current = pos.atStop?.id ?? pos.prevStop?.id;
  const auto = Math.max(0, calls.findIndex((c) => c.stopId === current));
  const start = offset ?? auto;
  const p = page(calls, start, limit);
  const dest = place(info.destination);
  const planned = place(info.plannedDestination);
  return {
    ...env(asOf),
    trainId: String(info.trainId ?? trainId),
    number: info.number ?? null,
    line: info.line ?? pos.line ?? null,
    category: info.category ?? pos.category ?? null,
    operator: info.operator ?? null,
    status: info.status ?? null,
    delaySec: pos.delaySec ?? null,
    origin: place(info.origin),
    destination: dest,
    ...(planned && dest && planned.stopId !== dest.stopId ? { plannedDestination: planned } : {}),
    disruptionId: info.disruptionId ?? null,
    position: { lat: pos.lat ?? null, lon: pos.lon ?? null, speedKmh: pos.speedKmh ?? null, motion: pos.motion ?? null, track: pos.track ?? null, ts: time(pos.ts, ref) },
    atStop: place(pos.atStop),
    prevStop: place(pos.prevStop),
    nextStop: place(pos.nextStop),
    calls: p.items.map((c) => ({ stopId: c.stopId, name: c.name, plannedArr: time(c.plannedArr, ref), expectedArr: time(c.expectedArr, ref), plannedDep: time(c.plannedDep, ref), expectedDep: time(c.expectedDep, ref), skipped: !!c.skipped, cancelled: !!c.cancelled })),
    callsOffset: start,
    nextOffset: p.nextOffset,
  };
}

// ------------------------------------------------------------------ stations
const names = new Map<string, string>();
async function stationName(cfg: Config, stopId: string) {
  if (names.has(stopId)) return names.get(stopId)!;
  try {
    const { data } = await get<Any[]>(cfg, "twin", "/stations", { q: stopId }, 600000);
    const hit = (data ?? []).find((s) => String(s.id) === stopId);
    if (hit) names.set(stopId, hit.name);
    return hit?.name ?? null;
  } catch {
    return null;
  }
}

export async function searchStations(cfg: Config, q: string, limit = 6) {
  const { data } = await get<Any[]>(cfg, "twin", "/stations", { q }, 600000);
  return (data ?? []).slice(0, limit).map((s) => {
    names.set(String(s.id), s.name);
    return { stopId: String(s.id), name: String(s.name) };
  });
}

export async function stationBoard(cfg: Config, stopId: string, view: "departures" | "arrivals", limit: number) {
  const [{ data, at }, name] = await Promise.all([get<Any[]>(cfg, "twin", `/stations/${seg(stopId)}/${view === "arrivals" ? "arrivals" : "board"}`, {}, 5000), stationName(cfg, stopId)]);
  const ref = ymd(at);
  const rows = (data ?? []).slice(0, limit).map((x) =>
    view === "arrivals"
      ? { trainId: x.trainId, line: x.line, category: x.category, headsign: x.headsign, plannedArr: time(x.plannedArr, ref), expectedArr: time(x.expectedArr, ref), etaSec: x.etaSec, delaySec: x.delaySec, stopsAway: x.stopsAway, status: x.status }
      : { trainId: x.trainId, line: x.line, category: x.category, headsign: x.headsign, ...(x.plannedHeadsign && x.plannedHeadsign !== x.headsign ? { plannedHeadsign: x.plannedHeadsign } : {}), planned: time(x.planned, ref), expected: time(x.expected, ref), delayMin: x.delayMin ?? 0, cancelled: !!x.cancelled, ...(x.disruptionId ? { disruptionId: x.disruptionId } : {}) },
  );
  return { ...env(at, "retrieved"), station: { stopId, name }, view, rows };
}

// ------------------------------------------------------------------ brief
const compactDisruption = (x: Any, ref: string) => ({
  id: x.id, kind: "disruption", source: "control", title: x.title, description: x.description, effect: x.effect, cause: x.cause?.label ?? x.cause ?? null,
  expectedEnd: time(x.expectedEnd ?? x.until, ref), durationType: x.durationType ?? null, lines: x.effect === "interrupted" ? (x.lines ?? []) : [],
  replacementBus: x.replacementBus ? { route: x.replacementBus.route ?? [], next: (x.replacementBus.next ?? []).slice(0, 3).map((n: Any) => ({ from: n.from, to: n.to, departure: time(n.departure, ref), arrival: time(n.arrival, ref) })) } : null,
});
const compactAlert = (x: Any) => ({ id: x.id, kind: "alert", source: "sbb", title: x.title, description: typeof x.description === "string" && x.description.length > 600 ? x.description.slice(0, 600) + "…" : x.description, severity: x.severity, cause: x.cause });
const journeySummary = (j: Any, ref: string) => ({ journeyId: j.id, departure: time(j.departure, ref), arrival: time(j.arrival, ref), transfers: j.transfers, fastest: !!j.fastest, uncertain: !!j.uncertain, warnings: j.warnings ?? [] });

export async function railBrief(cfg: Config, fromStopId: string, toStopId?: string) {
  const q = toStopId ? { from: fromStopId, to: toStopId } : { station: fromStopId };
  const { data: b, at } = await get<Any>(cfg, "twin", "/brief", q, 5000, toStopId ? 6000 : 3000);
  if (b?.error) throw new ToolError("not_found", String(b.error));
  const ref = ymd(b.generatedAt ?? at);
  return {
    ...env(b.generatedAt ?? at),
    from: place(b.from ?? b.station),
    to: place(b.to),
    disruptions: (b.disruptions ?? []).map((x: Any) => compactDisruption(x, ref)),
    alerts: (b.alerts ?? []).map(compactAlert),
    departures: (b.departures ?? []).slice(0, 8).map((x: Any) => ({ trainId: x.trainId, line: x.line, category: x.category, headsign: x.headsign, planned: time(x.planned, ref), expected: time(x.expected, ref), delayMin: x.delayMin ?? 0, cancelled: !!x.cancelled })),
    journeys: (b.journeys ?? []).slice(0, 3).map((j: Any) => journeySummary(j, ref)),
  };
}

// ------------------------------------------------------------------ planner
const projectLeg = (l: Any, ref: string) => ({
  trainId: l.trainId, line: l.line, category: l.category, headsign: l.headsign ?? null, from: place(l.from), to: place(l.to),
  plannedDep: time(l.from?.plannedDep, ref), expectedDep: time(l.from?.expectedDep, ref), plannedArr: time(l.to?.plannedArr, ref), expectedArr: time(l.to?.expectedArr, ref),
  status: l.status ?? null, delaySec: l.delaySec ?? 0, stopsBetween: l.stopsBetween ?? null, ...(l.note ? { note: l.note } : {}), incidentIds: (l.incidents ?? []).map((i: Any) => i.id),
});
const projectJourney = (j: Any, ref: string) => ({
  journeyId: j.id, departure: time(j.departure, ref), arrival: time(j.arrival, ref), plannedDeparture: time(j.plannedDeparture, ref), plannedArrival: time(j.plannedArrival, ref),
  durationMin: j.durationMin ?? null, transfers: j.transfers, fastest: !!j.fastest, uncertain: !!j.uncertain, waitsForReopening: !!j.waitsForReopening, nextServiceDay: !!j.nextServiceDay,
  warnings: j.warnings ?? [], legs: (j.legs ?? []).map((l: Any) => projectLeg(l, ref)),
});

export async function planJourneys(cfg: Config, a: { fromStopId: string; toStopId: string; afterMs?: number; viaStopId?: string; maxTransfers?: number; includeWait?: boolean; limit?: number }) {
  const limit = a.limit ?? 3;
  const { data: p, at } = await get<Any>(cfg, "twin", "/plan", {
    from: a.fromStopId, to: a.toStopId, after: a.afterMs, via: a.viaStopId, maxTransfers: a.maxTransfers ?? 3,
    includeWait: a.viaStopId ? undefined : (a.includeWait ?? true) ? true : undefined, limit: 6,
  }, 5000, 6000);
  if (p?.error) throw new ToolError("not_found", String(p.error));
  const ref = ymd(p.generatedAt ?? at);
  const all: Any[] = p.journeys ?? [];
  const rec = all.find((j) => j.fastest && !j.uncertain) ?? null;
  // keep the recommended journey, then the earliest others, up to the limit, in arrival order
  const keep = new Set<Any>(rec ? [rec] : []);
  for (const j of all) if (keep.size < limit) keep.add(j);
  const journeys = all.filter((j) => keep.has(j)).map((j) => projectJourney(j, ref));
  return {
    ...env(p.generatedAt ?? at),
    from: place(p.from), to: place(p.to),
    recommendedJourneyId: rec?.id ?? null,
    journeys,
    alternativesConsidered: p.alternativesConsidered ?? null,
  };
}

export async function journeyStops(cfg: Config, journeyId: string, offset = 0, limit = 12) {
  let r;
  try {
    r = await get<Any>(cfg, "twin", `/journeys/${seg(journeyId)}`, {}, 5000);
  } catch (e) {
    if (e instanceof ToolError && e.code === "not_found") throw new ToolError("journey_expired", "Journey expired or unknown (ids live about 30 minutes). Run plan_journeys again.");
    throw e;
  }
  const j = r.data;
  const ref = ymd(j.generatedAt ?? r.at);
  const calls: Any[] = [];
  (j.legs ?? []).forEach((l: Any, legIndex: number) => {
    for (const c of l.calls ?? [])
      calls.push({ legIndex, stopId: c.id, name: c.name, plannedArr: time(c.plannedArr, ref), expectedArr: time(c.expectedArr, ref), plannedDep: time(c.plannedDep, ref), expectedDep: time(c.expectedDep, ref), served: c.served !== false });
  });
  const p = page(calls, offset, limit);
  return {
    ...env(j.generatedAt ?? r.at),
    journeyId: j.id ?? journeyId,
    departure: time(j.departure, ref), arrival: time(j.arrival, ref), transfers: j.transfers ?? null, fastest: !!j.fastest, uncertain: !!j.uncertain,
    legs: (j.legs ?? []).map((l: Any, legIndex: number) => ({ legIndex, line: l.line, category: l.category, trainId: l.trainId, headsign: l.headsign ?? null, from: place(l.from), to: place(l.to) })),
    calls: p.items,
    nextOffset: p.nextOffset,
  };
}
