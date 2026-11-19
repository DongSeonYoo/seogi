import type { Utterance } from "./types";

/** Concurrent tracks and import workers may finish out of order or overlap a snapshot. */
export function mergeUtterances(current: Utterance[], added: Utterance[]): Utterance[] {
  if (!added.length) return current;
  const ids = new Set(current.map((u) => u.id));
  const fresh = added.filter((u) => {
    if (ids.has(u.id)) return false;
    ids.add(u.id);
    return true;
  });
  return fresh.length ? current.concat(fresh).sort((a, b) => a.startSec - b.startSec || a.id - b.id) : current;
}

const ENDS_SENTENCE = /[.?!。…]["')\]]*$/;
const MAX_JOIN_GAP_SEC = 30;

/**
 * Rejoins sentences that a forced chunk cut split in two. Chunk transcripts are split at sentence
 * punctuation, so only a chunk's last piece can end without it; when that piece is followed by the
 * same speaker within a chunk length, the two are one sentence. Runs at read time over
 * start-ordered utterances because chunks are transcribed concurrently and land out of order.
 */
export function joinSplitSentences(utterances: Utterance[]): Utterance[] {
  const out: Utterance[] = [];
  for (const u of utterances) {
    const prev = out.at(-1);
    if (
      prev &&
      prev.track === u.track &&
      prev.speaker === u.speaker &&
      !ENDS_SENTENCE.test(prev.text.trim()) &&
      u.startSec - prev.startSec < MAX_JOIN_GAP_SEC
    ) {
      out[out.length - 1] = { ...prev, text: `${prev.text.trim()} ${u.text.trim()}` };
    } else {
      out.push(u);
    }
  }
  return out;
}
