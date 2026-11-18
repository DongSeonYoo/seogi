import type { MeetingRow, Utterance } from "../../shared/types";

export function clock(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function timeOfDay(iso: string) {
  return new Date(iso).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
}

export function fullDate(iso: string) {
  return new Date(iso).toLocaleString("ko-KR", { dateStyle: "long", timeStyle: "short" });
}

/** Discord-style channel categories by recency. */
export function groupByDay(meetings: MeetingRow[], now = new Date()) {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOfDay(now);
  const day = 86_400_000;
  const label = (iso: string) => {
    const t = startOfDay(new Date(iso));
    if (t >= today) return "오늘";
    if (t >= today - day) return "어제";
    if (t >= today - 6 * day) return "지난 7일";
    return new Date(iso).toLocaleDateString("ko-KR", { year: "numeric", month: "long" });
  };
  const groups: { label: string; items: MeetingRow[] }[] = [];
  for (const m of meetings) {
    const l = label(m.startedAt);
    const last = groups.at(-1);
    if (last?.label === l) last.items.push(m);
    else groups.push({ label: l, items: [m] });
  }
  return groups;
}

/** Discord message grouping: consecutive lines from one speaker within two minutes share a header. */
export function groupUtterances<T extends Utterance>(utterances: T[], gapSec = 120) {
  const groups: T[][] = [];
  for (const u of utterances) {
    const last = groups.at(-1);
    const prev = last?.at(-1);
    if (last && prev && prev.track === u.track && u.startSec - prev.startSec < gapSec) last.push(u);
    else groups.push([u]);
  }
  return groups;
}

export const SPEAKER = { mic: "나", system: "상대" } as const;
