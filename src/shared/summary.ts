import type { Translate } from "./i18n";
import type { SpeakerNames, Summary, Track, Utterance } from "./types";

/** "Speaker 2" when diarization told voices apart, else the track: "Me" or "Others". */
/** One voice in a meeting: a numbered speaker, else the track (the recorder, or the other side). */
export const speakerKey = (u: { track: Track; speaker: number | null }) => (u.speaker ? String(u.speaker) : u.track);

export function speakerName(u: { track: Track; speaker: number | null }, t: Translate, names: SpeakerNames = {}) {
  return names[speakerKey(u)] || (u.speaker ? t("speaker.n", { n: u.speaker }) : t(u.track === "mic" ? "speaker.mic" : "speaker.system"));
}

/**
 * Summaries are kept as Markdown the user edits freely; the model's structured answer is turned
 * into this text once, when it arrives.
 */
export function summaryMarkdown(s: Summary, t: Translate): string {
  const parts = [`## ${t("summary.overview")}`, s.overview];
  if (s.decisions.length) parts.push(`## ${t("summary.decisions")}`, s.decisions.map((d) => `- ${d}`).join("\n"));
  if (s.actionItems.length)
    parts.push(
      `## ${t("summary.actionItems")}`,
      s.actionItems.map((a) => `- [ ] ${a.task} — ${a.owner}, ${a.due}`).join("\n"),
    );
  if (s.topics.length)
    parts.push(
      `## ${t("summary.topics")}`,
      s.topics.map((x) => [`### ${x.title}`, ...x.points.map((p) => `- ${p}`)].join("\n")).join("\n\n"),
    );
  return parts.join("\n\n");
}

/** Two fields use total minutes in older notes, three fields start with hours. */
export const TIME_LINK = /\[(\d+:(?:[0-5]?\d:)?[0-5]\d)\]/g;
const PREVIEW_TIME = new RegExp(`\\s*${TIME_LINK.source}`, "g");

export function clockSeconds(label: string) {
  return label.split(":").reduce((seconds, field) => seconds * 60 + Number(field), 0);
}

/** The first line of prose in a summary, for the meeting list. */
export function summaryPreview(markdown: string): string | null {
  const line = markdown
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  // Time links help in the pane but are noise in a one-line preview.
  return line ? plainLine(line).replace(PREVIEW_TIME, "") : null;
}

/** Markdown to readable plain text: headings lose their marks, list items become bullets. */
export function markdownToText(markdown: string): string {
  return markdown
    .split("\n")
    .map((l) => {
      const heading = /^#{1,6}\s+(.*)$/.exec(l);
      return heading ? heading[1] : plainLine(l);
    })
    .join("\n");
}

function plainLine(l: string) {
  return l
    .replace(/^(\s*)[-*]\s+\[( |x)\]\s+/i, (_m, sp, done) => `${sp}${done.trim() ? "☑" : "☐"} `)
    .replace(/^(\s*)[-*]\s+/, "$1• ")
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1");
}

export function clock(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** A meeting as one document: title, date, summary, then the transcript. */
export function meetingDocument(
  m: { title: string; startedAt: string; summary: string | null; utterances: Utterance[]; speakerNames?: SpeakerNames },
  format: "md" | "txt",
  t: Translate,
  date: string,
): string {
  const md = [
    `# ${m.title}`,
    date,
    // The summary's own headings sit one level below its section.
    ...(m.summary?.trim() ? [`## ${t("detail.summary")}`, m.summary.trim().replace(/^(#{1,5})(?=\s)/gm, "#$1")] : []),
    `## ${t("export.transcript")}`,
    m.utterances.map((u) => `- \`${clock(u.startSec)}\` **${speakerName(u, t, m.speakerNames)}**: ${u.text}`).join("\n"),
  ].join("\n\n");
  return `${format === "md" ? md : markdownToText(md)}\n`;
}
