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

/**
 * A short line too brief to name by its sound, said between two lines of one named voice, is
 * almost always that voice (14 of 15 on the lab meeting, seogi-lab/diarize/sandwich.mjs). Longer
 * unnamed lines there were mostly someone nobody named, so they are left.
 */
const BETWEEN_MAX_SEC = 3;
/** Lone acknowledgements are as often a listener's as the speaker's, and sound cannot tell. */
const BACKCHANNEL =
  /^(?:(?:네|예|응|어|음|아|오|와|그쵸|그렇죠|맞아요|맞아|맞습니다|그래요|그래|좋아요|알겠습니다|yeah|yes|yep|yup|right|okay|ok|uh-huh|mm+|hmm+|sure|exactly|true|wow|oh|i see|got it)[\s.,!?…~]*)+$/i;
export const isBackchannel = (text: string) => BACKCHANNEL.test(text.trim());

/** Names for unnamed short lines between two lines of the same voice; `lines` in time order. */
export function nameBetween(lines: { id: number; startSec: number; speaker: number | null; text: string }[]) {
  const named = new Map<number, number>();
  for (let i = 1; i < lines.length - 1; i++) {
    const [before, line, after] = [lines[i - 1], lines[i], lines[i + 1]];
    if (line.speaker || !before.speaker || before.speaker !== after.speaker) continue;
    if (after.startSec - line.startSec <= BETWEEN_MAX_SEC && !isBackchannel(line.text)) named.set(line.id, before.speaker);
  }
  return named;
}

/**
 * A line like none of the voices so far (all below this), and long enough to tell, is a new voice:
 * the other side is told apart live before anyone is named. On the lab meeting (cluster.mjs) this
 * found 2 of 2 and 3 of 3 voices, none split, with 99.7-100% of named lines right.
 */
const VOICE_NEW = 0.4;
const VOICE_NEW_MIN_SEC = 3;

/**
 * Below VOICE_MATCH the closest voice was still right on every lab line (unsure.mjs) that was
 * long, or that sounded clearly more like it than like the next voice.
 */
const CLOSEST_MIN_SEC = 4;
const CLOSEST_LEAD = 0.1;

const dot = (a: Float32Array, b: Float32Array) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
};

/** The voice (speaker number) a line `sec` long with embedding `v` belongs to, "new", or null: unsure. */
export function placeVoice(v: Float32Array, sec: number, voices: Map<number, Float32Array>): number | "new" | null {
  const scores = [...voices].map(([speaker, mean]) => [speaker, dot(v, mean)] as const).sort((a, b) => b[1] - a[1]);
  const [best, next] = scores;
  if (best && best[1] >= VOICE_MATCH) return best[0];
  if (sec >= VOICE_NEW_MIN_SEC && (!best || best[1] < VOICE_NEW)) return "new";
  if (best && (sec >= CLOSEST_MIN_SEC || best[1] - (next?.[1] ?? -1) >= CLOSEST_LEAD)) return best[0];
  return null;
}

/**
 * A recording meeting's voices. Each is the mean of its long lines, not its first one: a single
 * short line is noisy, more so over a phone. A new voice needs a second unlike line that sounds
 * like the first; until then that line stays unsure. On a phone call with one voice on the other
 * side this made 1-2 voices instead of 3-5, and 3 of 3 on the lab meeting instead of 4-8, at
 * 98% right (seogi-lab/diarize/placement.mjs, 3-4 s spans).
 */
export class VoiceBook {
  private readonly voices = new Map<number, { mean: Float32Array; n: number }>();
  private pending: { line: number; v: Float32Array } | null = null;

  keys() {
    return this.voices.keys();
  }

  /** A line's voice joins `speaker`'s mean (placed there, or named by hand). */
  add(speaker: number, v: Float32Array) {
    const x = this.voices.get(speaker);
    if (!x) return void this.voices.set(speaker, { mean: v, n: 1 });
    const mean = Float32Array.from(x.mean, (m, i) => m * x.n + v[i]);
    const norm = Math.hypot(...mean) || 1;
    this.voices.set(speaker, { mean: mean.map((m) => m / norm), n: x.n + 1 });
  }

  /** One person heard as two: `from` joins `into`. */
  merge(from: number, into: number) {
    const x = this.voices.get(from);
    this.voices.delete(from);
    if (x) for (let i = 0; i < x.n; i++) this.add(into, x.mean);
  }

  /**
   * Where line `line` goes, as line → speaker: none (unsure, or waiting to be confirmed), its
   * own, or also the earlier line it confirmed as a new voice. `next` numbers a new voice.
   */
  place(line: number, v: Float32Array, sec: number, next: () => number): Map<number, number> {
    const out = new Map<number, number>();
    const means = new Map([...this.voices].map(([k, x]) => [k, x.mean]));
    const place = placeVoice(v, sec, means);
    if (place === "new") {
      if (this.voices.size && !(this.pending && dot(v, this.pending.v) >= VOICE_MATCH)) {
        this.pending = { line, v };
        return out;
      }
      const speaker = next();
      this.add(speaker, v);
      if (this.pending) {
        out.set(this.pending.line, speaker);
        this.add(speaker, this.pending.v);
        this.pending = null;
      }
      out.set(line, speaker);
    } else if (place !== null) {
      out.set(line, place);
      if (sec >= VOICE_NEW_MIN_SEC) this.add(place, v);
    }
    return out;
  }
}
