// Swiss local time for agents: every time is { ms, hm } (epoch ms and zero-padded HH:MM in Europe/Zurich).
const fmtHm = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fmtDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" });

export type Time = { ms: number; hm: string; date?: string } | null;

export const hm = (ms: number) => fmtHm.format(ms);
export const ymd = (ms: number) => fmtDate.format(ms); // YYYY-MM-DD

/** A time, with its date only when it is not on the reference (Swiss) date of the answer. */
export function time(ms: unknown, refDate?: string): Time {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const out: { ms: number; hm: string; date?: string } = { ms, hm: hm(ms) };
  const d = ymd(ms);
  if (refDate && d !== refDate) out.date = d;
  return out;
}
