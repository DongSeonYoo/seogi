import type { Translate } from "../shared/i18n";
import { appendDelta } from "../shared/text.ts";
import type { LiveEvent, LiveLine, LiveView, Track } from "../shared/types";

export type { LiveEvent };

const IN_RATE = 16_000;
const OPENAI_RATE = 24_000;
const OPENAI_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const PROJECT_NAME = "seogi";
// ponytail: caption streams are not logged in qgrid; turn on to see their usage there.
const QGRID_LOGGER = false;
/** Longest a stop waits for the transcripts of the last words before giving up on them. */
const STOP_WAIT_MS = 12_000;

/** One track's stream. Input is mono PCM16 at 16 kHz, every frame from the track's first sample. */
export type LiveStream = { audio(pcm: Int16Array): void; /** Resolves once the last transcripts are in. */ stop(): Promise<void> };

export type LiveConfig = { model: string; language?: string; prompt?: string; t: Translate } & (
  | { provider: "qgrid"; url: string }
  | { provider: "openai"; apiKey: string }
);

export function openLiveStream(config: LiveConfig, onEvent: (e: LiveEvent) => void): LiveStream {
  return config.provider === "qgrid" ? qgridStream(config, onEvent) : openaiStream(config, onEvent);
}

const b64 = (pcm: Int16Array) => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");

/**
 * qgrid's transcribeStream does the segmenting; this is a thin socket client. A socket that drops
 * mid-meeting is reopened; segment times of the new session count from where it joined.
 */
function qgridStream(
  config: LiveConfig & { provider: "qgrid" },
  onEvent: (e: LiveEvent) => void,
): LiveStream {
  let ws: WebSocket;
  let queue: string[] = [];
  let ready = false;
  let stopped = false;
  let failures = 0;
  let samples = 0; // input clock, 16 kHz
  let baseSec = 0; // where the current session joined the input clock
  let closed: () => void = () => {};
  const done = new Promise<void>((r) => (closed = r));
  const send = (event: string, data: unknown) => ws.send(JSON.stringify({ event, data }));

  function connect() {
    ws = new WebSocket(`${config.url.replace(/^http/, "ws").replace(/\/$/, "")}/api/qgrid/transcribeStream`);
    ready = false;
    baseSec = samples / IN_RATE;
    ws.onopen = () =>
      send("start", {
        sampleRate: IN_RATE,
        model: config.model,
        language: config.language,
        prompt: config.prompt,
        logger: QGRID_LOGGER,
        projectName: PROJECT_NAME,
      });
    ws.onmessage = (e) => {
      const { event, data } = JSON.parse(String(e.data));
      if (event === "ready") {
        ready = true;
        failures = 0;
        for (const pcm of queue.splice(0)) send("audio", { pcm });
        if (stopped) send("stop", {});
      } else if (event === "delta")
        onEvent({ type: "delta", id: `${baseSec}:${data.segmentId}`, text: data.text, atSec: samples / IN_RATE });
      else if (event === "segment")
        onEvent({
          type: "segment",
          id: `${baseSec}:${data.segmentId}`,
          text: data.text,
          startSec: baseSec + data.startMs / 1000,
          endSec: baseSec + data.endMs / 1000,
        });
      else if (event === "error") onEvent({ type: "error", message: data.message });
    };
    ws.onclose = (e) => {
      const lost = ready; // a working session dropped, not just a failed attempt
      ready = false;
      if (stopped) return closed();
      // Captions are the meeting record: keep trying, and say so once it is more than a blip.
      if (++failures > 2) onEvent({ type: "error", message: config.t("error.qgridClosed", { code: e.code }) });
      // Audio queued from here on goes to the new session.
      queue = [];
      if (lost) onEvent({ type: "reconnect" });
      setTimeout(connect, backoffMs(failures));
    };
  }

  connect();
  return {
    audio(pcm) {
      if (stopped) return;
      samples += pcm.length;
      if (ready) send("audio", { pcm: b64(pcm) });
      else queue.push(b64(pcm));
    },
    stop() {
      if (!stopped) {
        stopped = true;
        // qgrid finishes the outstanding segments, sends done and closes.
        if (ready) send("stop", {});
        else ws.close();
      }
      return Promise.race([done, sleep(STOP_WAIT_MS)]);
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
  let closed: () => void = () => {};
  const done = new Promise<void>((r) => (closed = r));

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
                model: config.model,
                // gpt-transcribe and gpt-live-transcribe take a list; sending both fields is an error.
                ...(config.language &&
                  (/^gpt-(live-)?transcribe/.test(config.model)
                    ? { languages: [config.language] }
                    : { language: config.language })),
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
      const lost = open; // a working session dropped, not just a failed attempt
      open = false;
      if (stopped) return;
      // A new session: audio sent to the old one but not transcribed is lost.
      current = undefined;
      awaitingAck = [];
      byItem.clear();
      policy.reset();
      if (++failures > 2)
        onEvent({ type: "error", message: config.t("error.openaiLiveFailed", { code: e.code, reason: e.reason }) });
      if (lost) onEvent({ type: "reconnect" });
      setTimeout(connect, backoffMs(failures));
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
      if (!stopped) {
        if (open) commit();
        stopped = true;
        // Leave time for the last transcript, then close.
        setTimeout(() => {
          ws.close();
          closed();
        }, 5000);
      }
      return Promise.race([done, sleep(STOP_WAIT_MS)]);
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

/** A finished stretch of speech, ready to be stored as an utterance. */
export type Segment = { startSec: number; text: string };

/**
 * One meeting's live captions for both tracks. Finished segments go to `onSegment` as they come
 * (the meeting record); `view` shows only the text still being spoken.
 */
export class LiveCaptions {
  private readonly drafts = new Map<string, LiveLine>();
  /** Finished lines, kept in the view only when nothing else shows them (the settings test). */
  private readonly finished: LiveLine[] = [];
  private readonly streams = new Map<Track, LiveStream>();
  private error: string | null = null;
  private stopped = false;
  /** Times a stream lost its connection; the meeting notes it once finished. */
  drops = 0;

  private readonly open: (onEvent: (e: LiveEvent) => void) => LiveStream;
  private readonly changed: () => void;
  private readonly store: ((track: Track, segment: Segment) => void) | null;

  /** `store` receives each finished segment; without one the view keeps them instead. */
  constructor(
    open: (onEvent: (e: LiveEvent) => void) => LiveStream,
    changed: () => void,
    store: ((track: Track, segment: Segment) => void) | null,
  ) {
    this.open = open;
    this.changed = changed;
    this.store = store;
  }

  private onSegment(track: Track, key: string, segment: Segment) {
    if (this.store) this.store(track, segment);
    else this.finished.push({ key, track, ...segment });
  }

  audio(track: Track, pcm: Int16Array) {
    if (this.stopped) return;
    let stream = this.streams.get(track);
    if (!stream) {
      try {
        stream = this.open((e) => this.onEvent(track, e));
      } catch (e) {
        stream = { audio() {}, stop: async () => {} };
        this.onEvent(track, { type: "error", message: e instanceof Error ? e.message : String(e) });
      }
      this.streams.set(track, stream);
    }
    stream.audio(pcm);
  }

  onEvent(track: Track, e: LiveEvent) {
    if (e.type === "error") this.error = e.message;
    else if (e.type === "reconnect") this.drops++;
    else {
      this.error = null; // captions are flowing again
      const key = `${track}:${e.id}`;
      const d = this.drafts.get(key);
      if (e.type === "delta")
        this.drafts.set(key, { key, track, startSec: d?.startSec ?? e.atSec, text: appendDelta(d?.text ?? "", e.text) });
      else {
        this.drafts.delete(key);
        if (e.text.trim()) this.onSegment(track, key, { startSec: e.startSec, text: e.text.trim() });
      }
    }
    this.changed();
  }

  /**
   * Ends the streams, waits for the transcripts of the last words (`tailMs` for a stream the
   * renderer drives), and stores what is still a draft as it stands.
   */
  async stop(tailMs = 0) {
    this.stopped = true;
    await Promise.all([...[...this.streams.values()].map((s) => s.stop()), sleep(tailMs)]);
    for (const d of [...this.drafts.values()].sort((a, b) => a.startSec - b.startSec))
      if (d.text.trim()) this.onSegment(d.track, d.key, { startSec: d.startSec, text: d.text.trim() });
    this.drafts.clear();
    this.changed();
  }

  view(): LiveView {
    const lines = [...this.finished, ...this.drafts.values()]
      .filter((d) => d.text.trim())
      .sort((a, b) => a.startSec - b.startSec)
      .map((d) => ({ ...d, text: d.text.trim() }));
    return { lines, error: this.error };
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Reconnect wait: grows with consecutive failures, capped at 10 s. */
const backoffMs = (failures: number) => 1000 * Math.min(10, failures);
