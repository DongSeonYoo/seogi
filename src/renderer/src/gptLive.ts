import { appendDelta } from "../../shared/text.ts";
import { GPT_LIVE_MODEL, GPT_LIVE_TAIL_MS, type LiveEvent, type Track } from "../../shared/types.ts";
import type { RecordingOptions } from "./recorder";

/**
 * GPT-Live's turn times run behind the speech by about this much (measured against saved audio:
 * 0.7–0.9 s), so a line would start, and play, after its first words.
 */
const LAG_SEC = 0.8;
/** A pause this long between pieces of a turn ends the sentence in progress. */
const PAUSE_SEC = 2;
/** A run-on without punctuation is cut here, so no utterance grows without bound. */
const MAX_CHARS = 280;
/**
 * A sentence end followed by more text or by the end of what has arrived. A period right after a
 * digit is not one: it may be a decimal still arriving ("2." then "23").
 */
const SENTENCE_END = /(?:(?<!\d)\.|[?!…。])(?=\s|$|[^\s\d.,?!…。])/;
/** The longest wait between reconnect attempts; captions are the meeting record, so they never give up. */
const MAX_BACKOFF_SEC = 10;

/**
 * Live captions from GPT-Live: one WebRTC session per track through qgrid's liveCall. Only the
 * transcript of what people say (user turns) is used; the model's replies are never played and
 * their turns are ignored. A user turn can run for the whole meeting when the model stays silent,
 * so its text is cut into segments at sentence ends and pauses. A session that drops is reopened.
 * Times are seconds since `startedAt`, the recording clock's origin.
 */
export function startGptLive(
  streams: [Track, MediaStream][],
  startedAt: number,
  meetingId: number,
  onEvent: (track: Track, event: LiveEvent) => void,
  /** The first session of a track is up; audio before `atSec` of the recording never reached it. */
  onOpened: (track: Track, atSec: number) => void = () => {},
  testToken?: number,
): () => void {
  const stops = streams.map(([track, stream]) =>
    keepAlive(stream, startedAt, meetingId, (e) => onEvent(track, e), (at) => onOpened(track, at), testToken),
  );
  return () => stops.forEach((stop) => stop());
}

/** Keeps one track's session open until stopped, reconnecting after a drop. */
function keepAlive(
  stream: MediaStream,
  startedAt: number,
  meetingId: number,
  emit: (e: LiveEvent) => void,
  onOpened: (atSec: number) => void,
  testToken?: number,
) {
  let opened = false;
  let stopped = false;
  let failures = 0;
  let generation = 0;
  let controller: AbortController;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function open() {
    controller = new AbortController();
    const { signal } = controller;
    try {
      await session(stream, startedAt, ++generation, meetingId, signal, emit, {
        working: (atSec) => {
          if (signal.aborted) return;
          failures = 0;
          if (!opened) onOpened(atSec);
          opened = true;
        },
        lost: () => {
          if (signal.aborted) return;
          emit({ type: "reconnect" });
          retry();
        },
      }, testToken);
    } catch (e) {
      if (signal.aborted) return;
      failures++;
      emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
      retry();
    }
  }
  function retry() {
    controller.abort();
    timer = setTimeout(() => !stopped && void open(), 1000 * Math.min(MAX_BACKOFF_SEC, Math.max(1, failures)));
  }

  void open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    controller.abort();
  };
}

/** Turns cut into segments: the text of the sentence in progress and where it started. */
export class Segmenter {
  private readonly turns = new Map<string, { n: number; text: string; startSec: number; endSec: number }>();
  private readonly emit: (e: LiveEvent) => void;
  private readonly prefix: string;

  constructor(prefix: string, emit: (e: LiveEvent) => void) {
    this.prefix = prefix;
    this.emit = emit;
  }

  add(turnId: string, text: string, startSec: number, endSec: number) {
    let turn = this.turns.get(turnId);
    if (turn?.text && startSec - turn.endSec >= PAUSE_SEC) this.cut(turnId);
    turn = this.turns.get(turnId) ?? { n: 0, text: "", startSec, endSec };
    if (!turn.text) turn.startSec = startSec;
    turn.text = appendDelta(turn.text, text);
    turn.endSec = Math.max(turn.endSec, endSec);
    this.turns.set(turnId, turn);
    this.emit({ type: "delta", id: this.id(turnId, turn.n), text, atSec: startSec, endSec });

    // A piece can end one sentence and start the next ("다.서기"): finish each complete sentence.
    let end: RegExpExecArray | null;
    while ((end = SENTENCE_END.exec(turn.text))) {
      const rest = turn.text.slice(end.index + end[0].length).trimStart();
      this.emit({ type: "segment", id: this.id(turnId, turn.n), text: turn.text.slice(0, end.index + end[0].length).trim(), startSec: turn.startSec, endSec });
      turn = { n: turn.n + 1, text: rest, startSec, endSec };
      this.turns.set(turnId, turn);
      if (rest) this.emit({ type: "delta", id: this.id(turnId, turn.n), text: rest, atSec: startSec, endSec });
    }
    if (turn.text.length >= MAX_CHARS) this.cut(turnId);
  }

  /** Finishes the sentence in progress of `turnId`, or of every turn. */
  cut(turnId?: string) {
    if (turnId === undefined) {
      for (const id of this.turns.keys()) this.finish(id);
      return;
    }
    const turn = this.turns.get(turnId);
    if (!turn) return;
    if (turn.text.trim())
      this.emit({ type: "segment", id: this.id(turnId, turn.n), text: turn.text.trim(), startSec: turn.startSec, endSec: turn.endSec });
    turn.n++;
    turn.text = "";
  }

  finish(turnId: string) {
    this.cut(turnId);
    this.turns.delete(turnId);
  }

  private id(turnId: string, n: number) {
    return `${this.prefix}:${turnId}:${n}`;
  }
}

async function session(
  stream: MediaStream,
  startedAt: number,
  gen: number,
  meetingId: number,
  signal: AbortSignal,
  emit: (e: LiveEvent) => void,
  on: { working: (atSec: number) => void; lost: () => void },
  testToken?: number,
) {
  const pc = new RTCPeerConnection();
  const clones: MediaStreamTrack[] = [];
  let channel: RTCDataChannel | undefined;
  // Event times are milliseconds of session audio, which starts flowing once the peer connects;
  // session.started arrives about a second later, so it only sets the origin if that was missed.
  let offset = (Date.now() - startedAt) / 1000;
  let anchored = false;
  const userTurns = new Set<string>();
  const segments = new Segmenter(`g${gen}`, emit);
  let closed = false;
  const stopClones = () => clones.splice(0).forEach((track) => track.stop());
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", stop);
    stopClones();
    channel?.close();
    pc.close();
    segments.cut();
  };
  const stop = () => {
    stopClones();
    if (channel?.readyState !== "open") return close();
    // Give the last words time to arrive, then end billing before disconnecting the peer.
    setTimeout(() => {
      if (closed || channel?.readyState !== "open") return close();
      segments.cut();
      try {
        channel.send(JSON.stringify({ type: "session.close" }));
      } finally {
        setTimeout(close, 500);
      }
    }, GPT_LIVE_TAIL_MS);
  };
  const lost = () => {
    if (closed) return;
    close();
    on.lost();
  };

  type Timed = { start_ms?: number; end_ms?: number };
  const message = (msg: MessageEvent) => {
    if (closed) return;
    let e: Timed & {
      type?: string;
      turn?: Timed & { id: string; role: string; transcript: string };
      turn_id?: string;
      delta?: string;
    };
    try {
      e = JSON.parse(String(msg.data));
    } catch {
      return;
    }
    const add = (id: string, text: string, t: Timed) => {
      const start = Math.max(0, offset - LAG_SEC + (t.start_ms ?? 0) / 1000);
      segments.add(id, text, start, t.end_ms === undefined ? start : Math.max(start, offset - LAG_SEC + t.end_ms / 1000));
    };
    const turn = e.turn;
    if (e.type === "session.started") {
      if (!anchored) offset = (Date.now() - startedAt) / 1000;
      on.working(offset);
    } else if (turn && e.type === "turn.created" && turn.role === "user") {
      userTurns.add(turn.id);
      if (turn.transcript) add(turn.id, turn.transcript, turn);
    } else if (e.type === "turn.delta" && e.turn_id && e.delta && userTurns.has(e.turn_id)) add(e.turn_id, e.delta, e);
    else if ((e.type === "turn.done" || e.type === "turn.completed") && turn && userTurns.delete(turn.id)) segments.finish(turn.id);
    else if (e.type === "session.closed") lost();
  };

  signal.addEventListener("abort", stop, { once: true });
  try {
    // Own the clone even if addTrack throws.
    for (const track of stream.getAudioTracks()) {
      const clone = track.clone();
      clones.push(clone);
      pc.addTrack(clone);
    }
    channel = pc.createDataChannel("oai-events");
    channel.addEventListener("message", message);
    channel.addEventListener("close", lost);
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "connected" && !anchored) {
        offset = (Date.now() - startedAt) / 1000;
        anchored = true;
      }
      if (pc.connectionState === "failed" || pc.connectionState === "closed") lost();
    });
    const offer = await pc.createOffer();
    if (signal.aborted) return;
    await pc.setLocalDescription(offer);
    if (signal.aborted) return;
    const answer = await window.api.liveCall(offer.sdp ?? "", meetingId, testToken);
    if (signal.aborted) return;
    if (!answer.ok) throw new Error(answer.error);
    await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
  } catch (e) {
    close();
    throw e;
  }
}

/**
 * Recorder hooks that feed live captions for `meetingId`: PCM frames to the main process for the
 * streaming providers, or WebRTC sessions for GPT-Live. Call `stop` when the recording ends.
 */
export function liveCaptionHooks(meetingId: number, live: { provider: string; model: string }, testToken?: number) {
  let stopGptLive: (() => void) | null = null;
  let stopped = false;
  const gpt = live.provider === "qgrid" && live.model === GPT_LIVE_MODEL;
  // A GPT-Live session takes a second or two to connect, and what is said before then never
  // reaches it. Each track's audio is kept until its session is up; that opening stretch is then
  // transcribed on its own (as a file) so the first words are not lost.
  const opening = new Map<Track, Int16Array[]>();
  const sendOpening = (track: Track, untilSec = Infinity) => {
    const frames = opening.get(track);
    opening.delete(track);
    if (!frames?.length) return;
    const pcm = concat(frames).subarray(0, Math.round(untilSec * 16000));
    if (hasSpeech(pcm)) void window.api.transcribeOpening(meetingId, track, pcm, testToken);
  };
  const options: Pick<RecordingOptions, "onFrame" | "onStreams"> = gpt
    ? {
        onStreams: (streams) => {
          if (stopped) return;
          for (const [track] of streams) opening.set(track, []);
          // The recorder's clock starts here, so caption times line up with the saved audio.
          stopGptLive = startGptLive(
            streams,
            Date.now(),
            meetingId,
            (track, e) => window.api.sendLiveEvent(meetingId, track, e, testToken),
            sendOpening,
            testToken,
          );
        },
        onFrame: (track, pcm) => {
          const frames = opening.get(track);
          if (frames && frames.length < OPENING_MAX_FRAMES) frames.push(pcm);
        },
      }
    : { onFrame: (track, pcm) => window.api.sendLiveAudio(meetingId, track, pcm, testToken) };
  return {
    options,
    stop() {
      stopped = true;
      // A recording stopped before its session connected: all of it is opening audio.
      for (const track of opening.keys()) sendOpening(track);
      stopGptLive?.();
    },
  };
}

/** At most 30 s of 100 ms frames are kept while a session connects. */
const OPENING_MAX_FRAMES = 300;

function concat(frames: Int16Array[]) {
  const out = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}

/** Any 100 ms stretch above the recorder's silence level. */
function hasSpeech(pcm: Int16Array) {
  for (let i = 0; i < pcm.length; i += 1600) {
    let sq = 0;
    const end = Math.min(pcm.length, i + 1600);
    for (let j = i; j < end; j++) sq += (pcm[j] / 32768) ** 2;
    if (Math.sqrt(sq / (end - i)) >= 0.01) return true;
  }
  return false;
}
