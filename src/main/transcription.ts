export type Transcript = { text: string; words: { startSecond: number }[] };

/**
 * Splits a chunk transcript into sentences and dates each one. Word timings (when the provider
 * returns them) place a sentence by its character position; without them it is interpolated
 * over the chunk length.
 */
export function splitUtterances(t: Transcript, chunkStartSec: number, chunkSec: number) {
  const sentences = t.text.split(/(?<=[.?!。])\s+/).filter((x) => x.trim());
  const total = t.text.length || 1;
  let offset = 0;
  return sentences.map((text) => {
    const frac = offset / total;
    offset += text.length + 1;
    const rel = t.words.length
      ? t.words[Math.min(t.words.length - 1, Math.floor(frac * t.words.length))].startSecond
      : frac * chunkSec;
    return { startSec: chunkStartSec + rel, text };
  });
}

/**
 * On noise without speech, prompted caption models read the glossary prompt back as the transcript.
 * Treats a transcript that is only a piece of the prompt as empty. A lone glossary word that
 * was really spoken is dropped too.
 */
export function isPromptEcho(text: string, prompt: string): boolean {
  const norm = (s: string) => s.replace(/[\s\p{P}]/gu, "");
  const t = norm(text);
  return t.length > 0 && norm(prompt).includes(t);
}

/** Steers the spelling of names and terms; the prefix is in the meeting's language. */
export function glossaryPrompt(language: string, glossary: string) {
  return `${language === "ko" ? "용어" : "Glossary"}: ${glossary}`;
}

/** A glossary's terms: separated by commas or lines. */
export const glossaryTerms = (glossary: string) => glossary.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
