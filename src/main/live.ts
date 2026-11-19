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

type CaptionEvent = LiveEvent | { type: "gap"; message: string };
type Emit = (event: CaptionEvent) => void;
type Session = {
  start(): void;
  receive(data: string): void;
  audio(pcm: Int16Array, start: number): void;
  stop(): void;
};

const b64 = (pcm: Int16Array) => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");

export function openLiveStream(config: LiveConfig, emit: Emit): LiveStream {
  const queue: Int16Array[] = [];
  let samples = 0;
  let queued = 0;
  let gapStart: number | undefined;
  let socket: WebSocket | undefined;
  let session: Session | undefined;
  let generation = 0;
  let ready = false;
  let stopped = false;
  let stopSent = false;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let drain: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const { promise: done, resolve } = Promise.withResolvers<void>();

  function reportGap(end: number) {
    if (gapStart === undefined) return;
    emit({ type: "gap", message: config.t("error.captionGap", {
      from: (gapStart / IN_RATE).toFixed(1), to: (end / IN_RATE).toFixed(1),
    }) });
    gapStart = undefined;
  }

  function close() {
    clearTimeout(drain);
    clearTimeout(deadline);
    clearTimeout(retry);
    if (queued) gapStart ??= samples - queued;
    reportGap(samples);
    queued = queue.length = 0;
    const old = socket;
    socket = undefined; // ignore close and late transcript events for this generation
    session = undefined;
    old?.close();
    resolve();
  }

  function pump() {
    if (!ready || !socket || !session || stopSent) return;
    clearTimeout(drain);
    while (queue.length && socket.bufferedAmount < 256 * 1024) {
      const start = samples - queued;
      reportGap(start);
      const pcm = queue.shift()!;
      queued -= pcm.length;
      session.audio(pcm, start);
    }
    if (queue.length) drain = setTimeout(pump, 25);
    else if (stopped) {
      stopSent = true;
      session.stop();
    }
  }

  function connect() {
    if (stopped) return;
    const ws = config.provider === "qgrid"
      ? new WebSocket(`${config.url.replace(/^http/, "ws").replace(/\/$/, "")}/api/qgrid/transcribeStream`)
      // Node's WebSocket accepts headers; the DOM type only knows the protocols argument.
      : new WebSocket(OPENAI_URL, { headers: { Authorization: `Bearer ${config.apiKey}` } } as unknown as string[]);
    socket = ws;
    generation++;
    const onReady = () => {
      ready = true;
      failures = 0;
      pump();
    };
    const send = (msg: unknown) => ws.send(JSON.stringify(msg));
    const onDone = () => { if (stopSent) close(); };
    session = config.provider === "qgrid"
      ? qgridSession(config, generation, send, emit, onReady, onDone)
      : openaiSession(config, generation, send, emit, onReady, onDone);
    ws.onopen = () => { if (socket === ws && !stopped) session!.start(); };
    ws.onmessage = (e) => { if (socket === ws) session!.receive(String(e.data)); };
    ws.onclose = (e) => {
      if (socket !== ws) return;
      socket = undefined;
      session = undefined;
      clearTimeout(drain);
      const lost = ready;
      ready = false;
      if (stopped) return close();
      if (lost) emit({ type: "reconnect" });
      if (++failures > 2) emit({ type: "error", message: config.provider === "qgrid"
        ? config.t("error.qgridClosed", { code: e.code })
        : config.t("error.openaiLiveFailed", { code: e.code, reason: e.reason }) });
      retry = setTimeout(connect, backoffMs(failures));
    };
  }

  connect();
  return {
    audio(pcm) {
      if (stopped || !pcm.length) return;
      samples += pcm.length;
      queued += pcm.length;
      queue.push(pcm);
      while (queued > 30 * IN_RATE) {
        gapStart ??= samples - queued;
        const head = queue[0];
        const excess = Math.min(head.length, queued - 30 * IN_RATE);
        if (excess === head.length) queue.shift();
        else queue[0] = head.slice(excess); // release the discarded samples' backing store
        queued -= excess;
      }
      pump();
    },
    stop() {
      if (!stopped) {
        stopped = true;
        clearTimeout(retry);
        if (!ready) close();
        else {
          deadline = setTimeout(close, STOP_WAIT_MS);
          pump();
        }
      }
      return done;
    },
  };
}

/** qgrid timestamps count only samples delivered to this socket, even across a backlog gap. */
function qgridSession(
  config: LiveConfig, generation: number, send: (msg: unknown) => void, emit: Emit, onReady: () => void, onDone: () => void,
): Session {
  const offsets: { sent: number; offset: number }[] = [];
  let sent = 0;
  let end = 0;
  const at = (ms: number, ending = false) => {
    const sample = Math.round(ms * IN_RATE / 1000);
    const offset = offsets.findLast((p) => ending ? p.sent < sample : p.sent <= sample) ?? offsets[0];
    return (sample + (offset?.offset ?? 0)) / IN_RATE;
  };
  return {
    start() {
      send({ event: "start", data: { sampleRate: IN_RATE, model: config.model, language: config.language,
        prompt: config.prompt, logger: QGRID_LOGGER, projectName: PROJECT_NAME } });
    },
    audio(pcm, start) {
      if (!sent || start !== end) offsets.push({ sent, offset: start - sent });
      sent += pcm.length;
      end = start + pcm.length;
      send({ event: "audio", data: { pcm: b64(pcm) } });
    },
    receive(raw) {
      const { event, data } = JSON.parse(raw);
      if (event === "ready") onReady();
      else if (event === "done") onDone();
      else if (event === "error") emit({ type: "error", message: data.message });
      else if (event === "delta")
        emit({ type: "delta", id: `q${generation}:${data.segmentId}`, text: data.text, atSec: end / IN_RATE });
      else if (event === "segment")
        emit({ type: "segment", id: `q${generation}:${data.segmentId}`, text: data.text, startSec: at(data.startMs), endSec: at(data.endMs, true) });
    },
    stop() { send({ event: "stop", data: {} }); },
  };
}

/** OpenAI takes no server VAD here. Commit acknowledgements bind segments to items in order. */
function openaiSession(
  config: LiveConfig, generation: number, send: (msg: unknown) => void, emit: Emit, onReady: () => void, onDone: () => void,
): Session {
  type Segment = { id: string; startSec: number; speechSec?: number; endSec?: number };
  const policy = new CommitPolicy();
  let end = 0;
  let nextId = 0;
  let current: Segment | undefined;
  const awaitingAck: Segment[] = [];
  const byItem = new Map<string, Segment>();

  function commit() {
    if (!current || !policy.hasSpeech) return;
    current.endSec = end / IN_RATE;
    awaitingAck.push(current);
    current = undefined;
    policy.reset();
    send({ type: "input_audio_buffer.commit" });
  }
  function finishIfIdle() {
    if (!awaitingAck.length && !byItem.size) onDone();
  }

  return {
    start() {
      send({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: OPENAI_RATE },
              transcription: {
                model: config.model,
                ...(config.language && (/^gpt-(live-)?transcribe/.test(config.model)
                  ? { languages: [config.language] } : { language: config.language })),
                ...(config.prompt && { prompt: config.prompt }),
              },
              turn_detection: null,
            },
          },
        },
      });
    },
    receive(raw) {
      const msg = JSON.parse(raw);
      switch (msg.type) {
        case "session.updated": onReady(); return;
        case "input_audio_buffer.committed": {
          const seg = awaitingAck.shift();
          if (seg) byItem.set(msg.item_id, seg);
          return;
        }
        case "conversation.item.input_audio_transcription.delta": {
          let seg = byItem.get(msg.item_id);
          if (!seg && current) byItem.set(msg.item_id, (seg = current));
          if (seg && msg.delta) emit({ type: "delta", id: seg.id, text: msg.delta, atSec: seg.speechSec ?? seg.startSec });
          return;
        }
        case "conversation.item.input_audio_transcription.failed":
        case "conversation.item.input_audio_transcription.completed": {
          const seg = byItem.get(msg.item_id);
          byItem.delete(msg.item_id);
          // An empty final also removes the failed item's draft from the view.
          if (seg) emit({ type: "segment", id: seg.id, text: msg.transcript?.trim() ?? "",
            startSec: seg.speechSec ?? seg.startSec, endSec: seg.endSec ?? end / IN_RATE });
          if (msg.type.endsWith(".failed")) emit({ type: "error", message: msg.error?.message ?? msg.type });
          finishIfIdle();
          return;
        }
        case "error":
          if (msg.error?.code !== "input_audio_buffer_commit_empty") emit({ type: "error", message: msg.error?.message ?? msg.type });
      }
    },
    audio(pcm, start) {
      if (current && start !== end) {
        // Start a fresh item after an omitted interval so its speech offset stays meaningful.
        if (policy.hasSpeech) commit();
        else {
          current = undefined;
          policy.reset();
          send({ type: "input_audio_buffer.clear" });
        }
      }
      end = start + pcm.length;
      current ??= { id: `o${generation}:${nextId++}`, startSec: start / IN_RATE };
      send({ type: "input_audio_buffer.append", audio: b64(resample(pcm, IN_RATE, OPENAI_RATE)) });
      const decision = policy.push(pcm);
      if (current.speechSec === undefined && policy.hasSpeech) current.speechSec = start / IN_RATE;
      if (decision === "commit") commit();
      else if (decision === "clear") {
        current = undefined;
        policy.reset();
        send({ type: "input_audio_buffer.clear" });
      }
    },
    stop() {
      commit();
      finishIfIdle();
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
  lastGap: string | null = null;
  private stopped = false;
  /** Times a stream lost its connection; the meeting notes it once finished. */
  drops = 0;

  private readonly open: (onEvent: Emit) => LiveStream;
  private readonly changed: () => void;
  private readonly store: ((track: Track, segment: Segment) => void) | null;

  /** `store` receives each finished segment; without one the view keeps them instead. */
  constructor(
    open: (onEvent: Emit) => LiveStream,
    changed: () => void,
    store: ((track: Track, segment: Segment) => void) | null,
  ) {
    this.open = open;
    this.changed = changed;
    this.store = store;
  }

  private onSegment(track: Track, key: string, segment: Segment) {
    if (this.store) this.store(track, segment);
    else {
      this.finished.push({ key, track, ...segment });
      this.finished.sort((a, b) => a.startSec - b.startSec);
      if (this.finished.length > 50) this.finished.shift();
    }
  }

  private flushDrafts(track?: Track) {
    for (const d of [...this.drafts.values()].sort((a, b) => a.startSec - b.startSec)) {
      if (track && d.track !== track) continue;
      this.drafts.delete(d.key);
      if (d.text.trim()) this.onSegment(d.track, d.key, { startSec: d.startSec, text: d.text.trim() });
    }
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

  onEvent(track: Track, e: CaptionEvent) {
    if (e.type === "error") this.error = e.message;
    else if (e.type === "reconnect") {
      this.drops++;
      this.flushDrafts(track);
    } else if (e.type === "gap") this.lastGap = e.message;
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
    this.flushDrafts();
    this.changed();
  }

  view(): LiveView {
    const lines = [...this.finished, ...this.drafts.values()]
      .filter((d) => d.text.trim())
      .sort((a, b) => a.startSec - b.startSec)
      .map((d) => ({ ...d, text: d.text.trim() }));
    return { lines, error: this.error ?? this.lastGap };
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Reconnect wait: grows with consecutive failures, capped at 10 s. */
const backoffMs = (failures: number) => 1000 * Math.min(10, failures);
