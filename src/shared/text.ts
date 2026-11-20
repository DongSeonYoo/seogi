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

/**
 * A caption as it is kept: sound tags the live models write ("[sigh ]", "[chuckle]") are dropped,
 * and a line left with no letter or digit (a lone "." a model starts a turn with) is no line.
 */
export function cleanCaption(text: string): string {
  const clean = text.replace(/\[[a-z][a-z _-]*\]\s*/gi, "").trim();
  return /[\p{L}\p{N}]/u.test(clean) ? clean : "";
}
