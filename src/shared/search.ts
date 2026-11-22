/**
 * How Seogi finds text, in ⌘K and in a meeting's ⌘F. A query of words matches a line holding all
 * of them in any order, ignoring case. A query of Korean initial consonants only ("ㅎㅂㅇㅈ")
 * matches the syllables that start with them, spaces ignored ("헤비 유저").
 */
const INITIALS = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

/** The initial consonant of a Hangul syllable; any other character as it is. */
const initial = (c: string) => {
  const code = c.charCodeAt(0) - 0xac00;
  return code >= 0 && code < 11172 ? INITIALS[Math.floor(code / 588)] : c;
};

export const isInitialsQuery = (query: string) => /^[ㄱ-ㅎ\s]+$/.test(query) && /[ㄱ-ㅎ]/.test(query);

/** Where `query` is found in `text`, as [start, end) character ranges in order; none if it is not. */
export function matchRanges(text: string, query: string): [number, number][] {
  const q = query.trim();
  if (!q) return [];
  if (isInitialsQuery(q)) {
    const want = q.replace(/\s+/g, "");
    const at: number[] = []; // positions in `text` of the characters kept
    let keys = "";
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) continue;
      at.push(i);
      keys += initial(text[i]);
    }
    const out: [number, number][] = [];
    for (let i = keys.indexOf(want); i >= 0; i = keys.indexOf(want, i + want.length)) out.push([at[i], at[i + want.length - 1] + 1]);
    return out;
  }
  const lower = text.toLowerCase();
  const out: [number, number][] = [];
  for (const word of q.toLowerCase().split(/\s+/)) {
    const before = out.length;
    for (let i = lower.indexOf(word); i >= 0; i = lower.indexOf(word, i + word.length)) out.push([i, i + word.length]);
    if (out.length === before) return []; // every word must be there
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * A stretch of a long line from just before its first match, for a one-line result row (which
 * cuts the end): [text, ranges in it].
 */
export function snippet(text: string, ranges: [number, number][], before = 16, after = 120): [string, [number, number][]] {
  const first = ranges[0]?.[0] ?? 0;
  const from = Math.max(0, first - before);
  const to = Math.min(text.length, (ranges[0]?.[1] ?? 0) + after);
  const lead = from > 0 ? "…" : "";
  const shift = from - lead.length;
  return [
    `${lead}${text.slice(from, to)}${to < text.length ? "…" : ""}`,
    ranges.filter(([a, b]) => a >= from && b <= to).map(([a, b]) => [a - shift, b - shift]),
  ];
}
