import { clock, TIME_LINK } from "../shared/summary.ts";
import { storedMessage } from "../shared/i18n.ts";
import type { Summary, Utterance } from "../shared/types";

type Point = { text: string; ids: number[] };
export type CitedNotes = {
  title: string;
  overview: Point[];
  decisions: Point[];
  actionItems: { task: string; owner: string; due: string; ids: number[] }[];
  topics: { title: string; points: Point[] }[];
};
type Row = { label: string; text: string; ids: number[] };
type Stage = "transcript" | "merge";
type Generate = (stage: Stage, prompt: string) => Promise<CitedNotes>;

export const SUMMARY_OUTPUT = 4096;
/**
 * Transcript bytes per call. The catalog reports no context sizes, and the summary models in use
 * take 128K+ tokens; Korean runs about 4–5 UTF-8 bytes per token (English about 4), so 400 KB is
 * roughly 90–130K tokens: a few hours of meeting in one call. A provider that still reports the
 * input as too long gets that part split smaller (contextError below), so this only has to be a
 * good first guess. ponytail: read real limits once qgrid's catalog reports them.
 */
export const SUMMARY_INPUT = 400_000;
// Sizes are counted in UTF-8 bytes, including ids, speaker labels and newlines.
const cost = (text: string) => Buffer.byteLength(text, "utf8");
const render = (row: Row) => `${row.label}: ${row.text}`;
const promptFor = (rows: Row[]) => rows.map(render).join("\n");

/** Preserve speaker and source ids when a single turn is too long for a call. */
export function splitRows(rows: Row[], budget: number): Row[][] {
  const parts: Row[][] = [];
  let part: Row[] = [];
  let size = 0;
  function push(row: Row) {
    const bytes = cost(render(row));
    if (part.length && size + 1 + bytes > budget) {
      parts.push(part);
      part = [];
      size = 0;
    }
    size += (part.length ? 1 : 0) + bytes;
    part.push(row);
  }
  for (const row of rows) {
    const capacity = budget - cost(row.label + ": ");
    if (cost(row.text) <= capacity) { push(row); continue; }
    let text = "", bytes = 0;
    for (const ch of row.text) {
      const n = cost(ch);
      if (n > capacity) throw new Error(storedMessage("error.summaryBudget"));
      if (bytes + n > capacity) {
        push({ ...row, text });
        text = ""; bytes = 0;
      }
      text += ch;
      bytes += n;
    }
    if (text) push({ ...row, text });
  }
  if (part.length) parts.push(part);
  return parts;
}

function contextError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { statusCode?: number; message?: string; responseBody?: string; cause?: unknown; lastError?: unknown };
  if (e.statusCode === 413) return true;
  const length = /context[_ -](?:length|window|limit)[_ -]exceeded|maximum context length|too many (?:input )?tokens|(?:prompt|input|request) (?:is )?too (?:large|long)|exceeds? (?:the |this )?(?:maximum |model.s )?(?:context (?:window|limit)|(?:input|token) (?:length|limit))/i;
  return length.test(e.message ?? "") || length.test(e.responseBody ?? "") ||
    (e.cause !== error && contextError(e.cause)) || (e.lastError !== error && contextError(e.lastError));
}

// Only the app inserts time links. A model can still put a guessed time in a prose field.
const clean = (s: string) => s.replace(TIME_LINK, "").replace(/\[\d+\]/g, "").trim();
function validate(notes: CitedNotes, rows: Row[]): CitedNotes {
  const allowed = new Set(rows.flatMap((r) => r.ids));
  const refs = (ids: number[]) => [...new Set(ids.filter((id) => allowed.has(id)))].sort((a, b) => a - b);
  const points = (items: Point[]) => items.map((p) => ({ text: clean(p.text), ids: refs(p.ids) }))
    .filter((p) => p.text && p.ids.length);
  const valid = {
    title: clean(notes.title), overview: points(notes.overview), decisions: points(notes.decisions),
    actionItems: notes.actionItems.map((a) => ({ task: clean(a.task), owner: clean(a.owner), due: clean(a.due), ids: refs(a.ids) }))
      .filter((a) => a.task && a.ids.length),
    topics: notes.topics.map((t) => ({ title: clean(t.title), points: points(t.points) })).filter((t) => t.points.length),
  };
  if (!valid.overview.length && !valid.decisions.length && !valid.actionItems.length && !valid.topics.length)
    throw new Error(storedMessage("error.summaryCitations"));
  return valid;
}

/** A merge can only see the ids its children actually cited, in transcript order. */
function mergeRows(notes: CitedNotes[]): Row[] {
  const rows: Row[] = [];
  function add(kind: string, text: string, ids: number[]) {
    rows.push({ label: `${kind} [${ids.join(",")}]`, text, ids });
  }
  for (const n of notes) {
    n.overview.forEach((p) => add("overview", p.text, p.ids));
    n.decisions.forEach((p) => add("decision", p.text, p.ids));
    n.actionItems.forEach((a) => add("action", JSON.stringify({ task: a.task, owner: a.owner, due: a.due }), a.ids));
    n.topics.forEach((t) => t.points.forEach((p) => add("topic", JSON.stringify({ title: t.title, point: p.text }), p.ids)));
  }
  return rows.sort((a, b) => a.ids[0] - b.ids[0]);
}

export async function summarizeParts(lines: Utterance[], budget: number, generate: Generate): Promise<Summary> {
  const rows = lines.map((line, i) => ({
    label: `[${i + 1}] ${line.speaker ? `Speaker ${line.speaker}` : line.track === "mic" ? "Me" : "Others"}`,
    text: line.text, ids: [i + 1],
  }));
  if (!rows.length || budget < 1) throw new Error(storedMessage("error.summaryBudget"));
  async function run(stage: Stage, input: Row[], limit: number, retries: number): Promise<CitedNotes[]> {
    const notes: CitedNotes[] = [];
    for (const part of splitRows(input, limit)) {
      const prompt = promptFor(part);
      try {
        notes.push(validate(await generate(stage, prompt), part));
      } catch (error) {
        if (!retries || !contextError(error)) throw error;
        notes.push(...await run(stage, part, Math.floor(cost(prompt) / 2), retries - 1));
      }
    }
    return notes;
  }
  let notes = await run("transcript", rows, budget, 4);
  for (let level = 0; notes.length > 1; level++) {
    if (level >= 8) throw new Error(storedMessage("error.summaryMerge"));
    const input = mergeRows(notes);
    const merged = await run("merge", input, budget, 4);
    if (merged.length >= notes.length && cost(promptFor(mergeRows(merged))) >= cost(promptFor(input)))
      throw new Error(storedMessage("error.summaryMerge"));
    notes = merged;
  }
  const [n] = notes;
  const stamp = (text: string, ids: number[]) =>
    [text, ...new Set(ids.map((id) => `[${clock(lines[id - 1].startSec)}]`))].join(" ");
  return {
    title: n.title,
    overview: n.overview.map((p) => stamp(p.text, p.ids)).join(" "),
    decisions: n.decisions.map((p) => stamp(p.text, p.ids)),
    actionItems: n.actionItems.map((a) => ({ task: stamp(a.task, a.ids), owner: a.owner, due: a.due })),
    topics: n.topics.map((t) => ({ title: t.title, points: t.points.map((p) => stamp(p.text, p.ids)) })),
  };
}
