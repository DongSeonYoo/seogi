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

/**
 * Gives each recorded caption line the voice that talks most during it. A line runs until the
 * next line starts (at most one turn's length); a line in no voice's stretch takes the nearest.
 * Speakers are renumbered 1, 2, … in order of first line, so a voice with no lines leaves no gap.
 */
export function assignSpeakers(lines: { id: number; startSec: number }[], turns: Turn[]): Map<number, number> {
  const sorted = [...lines].sort((a, b) => a.startSec - b.startSec);
  const number = new Map<number, number>();
  const out = new Map<number, number>();
  if (!turns.length) return out;
  sorted.forEach((line, i) => {
    const start = line.startSec;
    const end = Math.min(sorted[i + 1]?.startSec ?? Infinity, start + MAX_TURN_SEC);
    const talk = new Map<number, number>();
    for (const t of turns) {
      const overlap = Math.min(end, t.end) - Math.max(start, t.start);
      if (overlap > 0) talk.set(t.speaker, (talk.get(t.speaker) ?? 0) + overlap);
    }
    let voice = [...talk].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (voice === undefined) {
      const gap = (t: Turn) => Math.max(t.start - start, start - t.end, 0);
      voice = turns.reduce((best, t) => (gap(t) < gap(best) ? t : best)).speaker;
    }
    if (!number.has(voice)) number.set(voice, number.size + 1);
    out.set(line.id, number.get(voice)!);
  });
  return out;
}

const RATE = 16000;
/** How far back a named line (or one waiting to be named) can still be heard. */
const KEEP_SEC = 300;
/**
 * How alike a line must sound to a named voice to take its name. On a real 3-person meeting
 * (seogi-lab/diarize, identify.mjs) 0.5 named 99-100% of lines right and left 17% unnamed.
 */
export const VOICE_MATCH = 0.5;
/** Shorter lines ("네") carry too little voice to tell apart. */
export const VOICE_MIN_SEC = 1;
/** A line's voice is read from at most this much of it. */
const VOICE_MAX_SEC = 8;

/** The last few minutes of the other side's audio in a recording stretch, by sample time. */
export class AudioRing {
  private readonly buf = new Int16Array(KEEP_SEC * RATE);
  private total = 0;

  push(pcm: Int16Array) {
    for (let i = 0; i < pcm.length; i += this.buf.length) {
      const part = pcm.subarray(i, i + this.buf.length);
      const at = this.total % this.buf.length;
      const first = Math.min(part.length, this.buf.length - at);
      this.buf.set(part.subarray(0, first), at);
      this.buf.set(part.subarray(first), 0);
      this.total += part.length;
    }
  }

  /** Audio from `startSec` to `endSec` of the stretch, or null when it is too short or gone. */
  slice(startSec: number, endSec: number): Float32Array<ArrayBuffer> | null {
    const from = Math.max(Math.round(startSec * RATE), this.total - this.buf.length, 0);
    const to = Math.min(Math.round(Math.min(endSec, startSec + VOICE_MAX_SEC) * RATE), this.total);
    if (to - from < VOICE_MIN_SEC * RATE) return null;
    const out = new Float32Array(to - from);
    for (let i = 0; i < out.length; i++) out[i] = this.buf[(from + i) % this.buf.length] / 32768;
    return out;
  }
}

/** The named voice (speaker number) `v` sounds most like, if it is alike enough. */
export function matchVoice(v: Float32Array, voices: Map<number, Float32Array[]>): number | null {
  let best: number | null = null;
  let score = VOICE_MATCH;
  for (const [speaker, samples] of voices)
    for (const s of samples) {
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i] * s[i];
      if (dot >= score) [best, score] = [speaker, dot];
    }
  return best;
}
