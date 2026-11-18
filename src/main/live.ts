import type { LiveLine, LiveView, Track } from "../shared/types";

/** Live captions are drafts: kept in memory only and replaced by the chunk transcripts. */

const IN_RATE = 16_000;
const OPENAI_RATE = 24_000;
const OPENAI_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
export const LIVE_MODEL = "gpt-live-transcribe";
const PROJECT_NAME = "seogi";
// The chunk transcripts of the same audio are already logged; drafts would only duplicate them.
const QGRID_LOGGER = false;

export type LiveEvent =
  | { type: "delta"; id: string; text: string; atSec: number }
  | { type: "segment"; id: string; text: string; startSec: number; endSec: number }
  | { type: "error"; message: string };

/** One track's stream. Input is mono PCM16 at 16 kHz, every frame from the track's first sample. */
export type LiveStream = { audio(pcm: Int16Array): void; stop(): void };

export type LiveConfig = { language?: string; prompt?: string } & (
  | { provider: "qgrid"; url: string }
  | { provider: "openai"; apiKey: string }
);

export function openLiveStream(config: LiveConfig, onEvent: (e: LiveEvent) => void): LiveStream {
  return config.provider === "qgrid" ? qgridStream(config, onEvent) : openaiStream(config, onEvent);
}

const b64 = (pcm: Int16Array) => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");

/** qgrid's transcribeStream does the segmenting; this is a thin socket client. */
function qgridStream(
  config: LiveConfig & { provider: "qgrid" },
  onEvent: (e: LiveEvent) => void,
): LiveStream {
  const ws = new WebSocket(`${config.url.replace(/^http/, "ws").replace(/\/$/, "")}/api/qgrid/transcribeStream`);
  const queue: string[] = [];
  let ready = false;
  let stopped = false;
  let samples = 0;
  const send = (event: string, data: unknown) => ws.send(JSON.stringify({ event, data }));

  ws.onopen = () =>
    send("start", {
      sampleRate: IN_RATE,
      language: config.language,
      prompt: config.prompt,
      logger: QGRID_LOGGER,
      projectName: PROJECT_NAME,
    });
  ws.onmessage = (e) => {
    const { event, data } = JSON.parse(String(e.data));
    if (event === "ready") {
      ready = true;
      for (const pcm of queue.splice(0)) send("audio", { pcm });
      if (stopped) send("stop", {});
    } else if (event === "delta")
      onEvent({ type: "delta", id: data.segmentId, text: data.text, atSec: samples / IN_RATE });
    else if (event === "segment")
      onEvent({
        type: "segment",
        id: data.segmentId,
        text: data.text,
        startSec: data.startMs / 1000,
        endSec: data.endMs / 1000,
      });
    else if (event === "error") onEvent({ type: "error", message: data.message });
  };
  ws.onclose = (e) => {
    if (!stopped) onEvent({ type: "error", message: `qgrid 연결이 끊겼습니다 (${e.code})` });
    stopped = true;
  };

  return {
    audio(pcm) {
      if (stopped) return;
      samples += pcm.length;
      if (ready) send("audio", { pcm: b64(pcm) });
      else queue.push(b64(pcm));
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (ready) send("stop", {});
      else ws.close();
    },
  };
}

/**
 * OpenAI realtime transcription with the user's key. gpt-live-transcribe takes no server VAD, so
 * segments are cut here by CommitPolicy and bound to items by the commit acks, in order.
 */
function openaiStream(
  config: LiveConfig & { provider: "openai" },
  onEvent: (e: LiveEvent) => void,
): LiveStream {
  type Segment = { id: string; startSec: number; speechSec?: number; endSec?: number };
  const policy = new CommitPolicy();
  let ws: WebSocket;
  let open = false;
  let stopped = false;
  let failures = 0;
  let samples = 0; // input clock, 16 kHz
  let nextId = 0;
  let current: Segment | undefined;
  let awaitingAck: Segment[] = [];
  const byItem = new Map<string, Segment>();
  const queue: Int16Array[] = [];
  const send = (msg: unknown) => ws.send(JSON.stringify(msg));

  function connect() {
    // Node's WebSocket (undici) takes headers; the DOM typing does not know that option.
    ws = new WebSocket(OPENAI_URL, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    } as unknown as string[]);
    ws.onopen = () => {
      open = true;
      send({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: OPENAI_RATE },
              transcription: {
                model: LIVE_MODEL,
                ...(config.language && { languages: [config.language] }),
                ...(config.prompt && { prompt: config.prompt }),
              },
              turn_detection: null,
            },
          },
        },
      });
      for (const pcm of queue.splice(0)) push(pcm);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      // Only a configured session counts as a working connection for the retry budget.
      if (msg.type === "session.updated") failures = 0;
      switch (msg.type) {
        case "input_audio_buffer.committed": {
          const seg = awaitingAck.shift();
          if (seg) byItem.set(msg.item_id, seg);
          return;
        }
        case "conversation.item.input_audio_transcription.delta": {
          let seg = byItem.get(msg.item_id);
          if (!seg && current) byItem.set(msg.item_id, (seg = current)); // streamed before the commit
          if (seg && msg.delta) onEvent({ type: "delta", id: seg.id, text: msg.delta, atSec: seg.speechSec ?? seg.startSec });
          return;
        }
        case "conversation.item.input_audio_transcription.completed": {
          const seg = byItem.get(msg.item_id);
          if (seg && msg.transcript?.trim())
            onEvent({
              type: "segment",
              id: seg.id,
              text: msg.transcript.trim(),
              startSec: seg.speechSec ?? seg.startSec,
              endSec: seg.endSec ?? samples / IN_RATE,
            });
          byItem.delete(msg.item_id);
          return;
        }
        case "conversation.item.input_audio_transcription.failed":
        case "error":
          if (msg.error?.code !== "input_audio_buffer_commit_empty")
            onEvent({ type: "error", message: msg.error?.message ?? msg.type });
      }
    };
    ws.onclose = (e) => {
      open = false;
      if (stopped) return;
      // A new session: audio sent to the old one but not transcribed is lost.
      current = undefined;
      awaitingAck = [];
      byItem.clear();
      policy.reset();
      if (++failures > 3) {
        stopped = true;
        onEvent({ type: "error", message: `OpenAI 실시간 연결 실패 (${e.code} ${e.reason})` });
        return;
      }
      setTimeout(connect, 1000 * failures);
    };
  }

  function push(pcm: Int16Array) {
    const start = samples;
    samples += pcm.length;
    current ??= { id: `o${nextId++}`, startSec: start / IN_RATE };
    send({ type: "input_audio_buffer.append", audio: b64(resample(pcm, IN_RATE, OPENAI_RATE)) });
    const decision = policy.push(pcm);
    if (current.speechSec === undefined && policy.hasSpeech) current.speechSec = start / IN_RATE;
    if (decision === "commit") commit();
    else if (decision === "clear") {
      current = undefined;
      policy.reset();
      send({ type: "input_audio_buffer.clear" });
    }
  }

  function commit() {
    if (!current || !policy.hasSpeech) return;
    current.endSec = samples / IN_RATE;
    awaitingAck.push(current);
    current = undefined;
    policy.reset();
    send({ type: "input_audio_buffer.commit" });
  }

  connect();
  return {
    audio(pcm) {
      if (stopped) return;
      if (open) push(pcm);
      else queue.push(pcm);
    },
    stop() {
      if (stopped) return;
      if (open) commit();
      stopped = true;
      // Leave time for the last transcript; the meeting drops its drafts when it finishes anyway.
      setTimeout(() => ws.close(), 5000);
    },
  };
}

export function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  const out = new Int16Array(Math.floor((pcm.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const x = (i * from) / to;
    const j = Math.floor(x);
    const a = pcm[j];
    const b = pcm[Math.min(j + 1, pcm.length - 1)];
    out[i] = Math.round(a + (b - a) * (x - j));
  }
  return out;
}

/**
 * Ported from qgrid's transcribe-stream CommitPolicy: end a segment after a pause that follows
 * enough speech, at a long pause after any speech, or at 20 s (gpt-live-transcribe reads only about
 * the first 30 s of a committed buffer). Quiet-only buffers are cleared, not committed.
 */
export class CommitPolicy {
  private segment = 0;
  private speech = 0;
  private quietRun = 0;
  static readonly MIN_SPEECH = 1.5 * IN_RATE;
  static readonly PAUSE = 0.6 * IN_RATE;
  static readonly LONG_PAUSE = 2 * IN_RATE;
  static readonly MAX = 20 * IN_RATE;
  static readonly IDLE = 1 * IN_RATE;

  get hasSpeech() {
    return this.speech > 0;
  }

  push(pcm: Int16Array): "none" | "commit" | "clear" {
    let sq = 0;
    for (const v of pcm) sq += (v / 32768) ** 2;
    const quiet = Math.sqrt(sq / Math.max(1, pcm.length)) < 0.01;
    this.segment += pcm.length;
    this.quietRun = quiet ? this.quietRun + pcm.length : 0;
    if (!quiet) this.speech += pcm.length;
    const P = CommitPolicy;
    if (!this.speech) return this.segment >= P.IDLE ? "clear" : "none";
    if (this.segment >= P.MAX || this.quietRun >= P.LONG_PAUSE) return "commit";
    return this.speech >= P.MIN_SPEECH && this.quietRun >= P.PAUSE ? "commit" : "none";
  }

  reset() {
    this.segment = this.speech = this.quietRun = 0;
  }
}

type Draft = LiveLine & { endSec?: number };

/**
 * One meeting's drafts for both tracks. A finished draft disappears once the chunk transcripts
 * that succeeded cover its whole time span; a failed chunk never settles, so its drafts stay.
 */
export class LiveCaptions {
  private readonly drafts = new Map<string, Draft>();
  private readonly settled: Record<Track, [number, number][]> = { mic: [], system: [] };
  private readonly streams = new Map<Track, LiveStream>();
  private error: string | null = null;
  private stopped = false;

  private readonly open: (onEvent: (e: LiveEvent) => void) => LiveStream;
  private readonly changed: () => void;

  constructor(open: (onEvent: (e: LiveEvent) => void) => LiveStream, changed: () => void) {
    this.open = open;
    this.changed = changed;
  }

  audio(track: Track, pcm: Int16Array) {
    if (this.stopped) return;
    let stream = this.streams.get(track);
    if (!stream) {
      try {
        stream = this.open((e) => this.onEvent(track, e));
      } catch (e) {
        stream = { audio() {}, stop() {} };
        this.onEvent(track, { type: "error", message: e instanceof Error ? e.message : String(e) });
      }
      this.streams.set(track, stream);
    }
    stream.audio(pcm);
  }

  onEvent(track: Track, e: LiveEvent) {
    if (e.type === "error") this.error = e.message;
    else {
      this.error = null; // captions are flowing again
      const key = `${track}:${e.id}`;
      const d = this.drafts.get(key);
      if (e.type === "delta") {
        if (d?.endSec !== undefined) return;
        this.drafts.set(key, { key, track, startSec: d?.startSec ?? e.atSec, text: (d?.text ?? "") + e.text });
      } else if (covered(this.settled[track], e.startSec, e.endSec)) this.drafts.delete(key);
      else this.drafts.set(key, { key, track, startSec: e.startSec, endSec: e.endSec, text: e.text });
    }
    this.changed();
  }

  /** A chunk of `track` from startSec to endSec now has its final transcript. */
  settle(track: Track, startSec: number, endSec: number) {
    this.settled[track].push([startSec, endSec]);
    let removed = false;
    for (const [key, d] of this.drafts)
      // A draft whose segment never finished (empty, failed, lost to a reconnect) is at most one
      // segment long.
      if (d.track === track && covered(this.settled[track], d.startSec, d.endSec ?? d.startSec + 20))
        removed = this.drafts.delete(key);
    if (removed) this.changed();
  }

  stop() {
    this.stopped = true;
    for (const s of this.streams.values()) s.stop();
  }

  view(): LiveView {
    const lines = [...this.drafts.values()]
      .filter((d) => d.text.trim())
      .sort((a, b) => a.startSec - b.startSec)
      .map(({ key, track, startSec, text }) => ({ key, track, startSec, text: text.trim() }));
    return { lines, error: this.error };
  }
}

/** Whether [start, end] lies inside the union of the ranges, give or take `slack` seconds. */
export function covered(ranges: [number, number][], start: number, end: number, slack = 1) {
  let reach = start;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (a - slack > reach) break;
    reach = Math.max(reach, b);
    if (reach + slack >= end) return true;
  }
  return false;
}
