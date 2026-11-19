import type { Translate } from "../../shared/i18n";
import type { Utterance } from "../../shared/types";

export function clock(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

type Fmt = { t: Translate; intl: string };

export function timeOfDay(iso: string, { intl }: Fmt) {
  return new Date(iso).toLocaleTimeString(intl, { hour: "numeric", minute: "2-digit" });
}

export function fullDate(iso: string, { intl }: Fmt) {
  return new Date(iso).toLocaleString(intl, { dateStyle: "long", timeStyle: "short" });
}

/** Meeting length in words: "45 s", "32 min", "1 hr 5 min". */
export function duration(sec: number, { t }: Fmt) {
  const s = Math.round(sec);
  if (s < 60) return t("time.seconds", { s });
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (!h) return t("time.minutes", { m });
  return m ? t("time.hoursMinutes", { h, m }) : t("time.hours", { h });
}

/** Mail-style list date: time today, "Yesterday", the weekday this week, then the date. */
export function listDate(iso: string, f: Fmt, now = new Date()) {
  const d = new Date(iso);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return timeOfDay(iso, f);
  if (days === 1) return f.t("time.yesterday");
  if (days < 7) return d.toLocaleDateString(f.intl, { weekday: "long" });
  return d.toLocaleDateString(f.intl, { year: "2-digit", month: "numeric", day: "numeric" });
}

/** Discord message grouping: consecutive lines from one speaker within two minutes share a header. */
export function groupUtterances<T extends Utterance>(utterances: T[], gapSec = 120) {
  const groups: T[][] = [];
  for (const u of utterances) {
    const last = groups.at(-1);
    const prev = last?.at(-1);
    if (last && prev && prev.track === u.track && prev.speaker === u.speaker && u.startSec - prev.startSec < gapSec) last.push(u);
    else groups.push([u]);
  }
  return groups;
}

