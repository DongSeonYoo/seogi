/** A stretch of one voice from diarization; `speaker` ids are the model's own. */
export type SpeakerSegment = { start: number; end: number; speaker: number };
export type Turn = SpeakerSegment;

/** Turns are what gets transcribed: one voice, at most this long so a transcriber reads it all. */
const MAX_TURN_SEC = 30;
/** A pause this short between pieces of one voice keeps them in one turn. */
const JOIN_GAP_SEC = 1;

/**
 * Joins a voice's back-to-back segments into turns and numbers speakers 1, 2, … in order of
 * first appearance (the model's ids are arbitrary).
 */
export function speakerTurns(segments: SpeakerSegment[]): Turn[] {
  const number = new Map<number, number>();
  const turns: Turn[] = [];
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    if (!number.has(s.speaker)) number.set(s.speaker, number.size + 1);
    const speaker = number.get(s.speaker)!;
    const last = turns.at(-1);
    if (last && last.speaker === speaker && s.start - last.end < JOIN_GAP_SEC && s.end - last.start <= MAX_TURN_SEC)
      last.end = Math.max(last.end, s.end);
    else turns.push({ start: s.start, end: s.end, speaker });
  }
  return turns;
}
