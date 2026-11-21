/** GPT-Live sends the next sentence without a leading space; other deltas carry their own spacing. */
export function appendDelta(text: string, delta: string) {
  return /[.?!…。]$/.test(text) && /^[^\s\d.,?!]/.test(delta) ? `${text} ${delta}` : text + delta;
}

/**
 * A sentence end followed by more text or by the end of what has arrived. A period right after a
 * digit is not one: it may be a decimal still arriving ("2." then "23").
 */
export const SENTENCE_END = /(?:(?<!\d)\.|[?!…。])(?=\s|$|[^\s\d.,?!…。])/;

/**
 * Cuts the finished sentences off `text`; `at(i)` is when its character i was spoken. The
 * unfinished rest (and when it began) waits for what comes next.
 */
export function finishedSentences(text: string, at: (i: number) => number) {
  const lines: { startSec: number; text: string }[] = [];
  const end = new RegExp(SENTENCE_END.source, "g");
  let from = 0;
  for (let m = end.exec(text); m; m = end.exec(text)) {
    const to = m.index + m[0].length;
    const line = text.slice(from, to).trim();
    if (line) lines.push({ startSec: at(from + (text.slice(from).length - text.slice(from).trimStart().length)), text: line });
    from = to;
  }
  const rest = text.slice(from).trim();
  return { lines, rest, restStartSec: at(text.length - text.slice(from).trimStart().length) };
}

/** Where the last sentence that another sentence has already followed ends (0: none yet). */
export function settledEnd(text: string): number {
  let to = 0;
  for (const m of text.matchAll(new RegExp(SENTENCE_END.source, "g"))) {
    const end = m.index + m[0].length;
    if (text.slice(end).trim()) to = end;
  }
  return to;
}

/** `text` without its first `count` sentences. */
export function afterSentences(text: string, count: number): string {
  const ends = [...text.matchAll(new RegExp(SENTENCE_END.source, "g"))].map((m) => m.index + m[0].length);
  return count ? text.slice(ends[count - 1] ?? text.length).trim() : text;
}

/** The script each translation language is written in. */
const SCRIPT: Record<string, RegExp> = { ko: /\p{Script=Hangul}/u, en: /\p{Script=Latin}/u };
/** Whether a line is already in `lang`: most of its letters are in that language's script. */
export function inLanguage(text: string, lang: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  const script = SCRIPT[lang];
  return !letters.length || (!!script && letters.filter((c) => script.test(c)).length * 2 >= letters.length);
}

/**
 * A caption as it is kept: sound tags the live models write ("[sigh ]", "[chuckle]") are dropped,
 * and a line left with no letter or digit (a lone "." a model starts a turn with) is no line.
 */
export function cleanCaption(text: string): string {
  const clean = text.replace(/\[[a-z][a-z _-]*\]\s*/gi, "").trim();
  return /[\p{L}\p{N}]/u.test(clean) ? clean : "";
}
