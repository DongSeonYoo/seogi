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
): () => void {
  const stops = streams.map(([track, stream]) => keepAlive(stream, startedAt, meetingId, (e) => onEvent(track, e)));
  return () => stops.forEach((stop) => stop());
}

/** Keeps one track's session open until stopped, reconnecting after a drop. */
function keepAlive(stream: MediaStream, startedAt: number, meetingId: number, emit: (e: LiveEvent) => void) {
  let stopped = false;
  let failures = 0;
  let generation = 0;
  let stopSession: (() => void) | null = null;

  async function open() {
    const gen = ++generation;
    try {
      stopSession = await session(stream, startedAt, gen, meetingId, emit, {
        working: () => (failures = 0),
        lost: () => {
          if (stopped || gen !== generation) return;
          emit({ type: "reconnect" });
          retry();
        },
      });
      if (stopped) stopSession();
    } catch (e) {
      if (stopped) return;
      failures++;
      emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
      retry();
    }
  }
  function retry() {
    stopSession?.();
    stopSession = null;
    setTimeout(() => !stopped && void open(), 1000 * Math.min(MAX_BACKOFF_SEC, Math.max(1, failures)));
  }

  void open();
  return () => {
    stopped = true;
    stopSession?.();
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
  emit: (e: LiveEvent) => void,
  on: { working: () => void; lost: () => void },
) {
  const pc = new RTCPeerConnection();
  // A copy of the track, so ending the session never stops the recorder's own capture.
  for (const t of stream.getAudioTracks()) pc.addTrack(t.clone());
  const channel = pc.createDataChannel("oai-events");
  // Event times are milliseconds of session audio, which starts flowing once the peer connects;
  // session.started arrives about a second later, so it only sets the origin if that was missed.
  let offset = (Date.now() - startedAt) / 1000;
  let anchored = false;
  const userTurns = new Set<string>();
  const segments = new Segmenter(`g${gen}`, emit);
  let closing = false;
  const lost = () => {
    if (closing) return;
    closing = true;
    segments.cut();
    pc.close();
    on.lost();
  };

  type Timed = { start_ms?: number; end_ms?: number };
  channel.addEventListener("message", (msg) => {
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
      on.working();
    } else if (turn && e.type === "turn.created" && turn.role === "user") {
      userTurns.add(turn.id);
      if (turn.transcript) add(turn.id, turn.transcript, turn);
    } else if (e.type === "turn.delta" && e.turn_id && e.delta && userTurns.has(e.turn_id)) add(e.turn_id, e.delta, e);
    else if ((e.type === "turn.done" || e.type === "turn.completed") && turn && userTurns.delete(turn.id)) segments.finish(turn.id);
    else if (e.type === "session.closed") lost();
  });
  channel.addEventListener("close", lost);
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "connected" && !anchored) {
      offset = (Date.now() - startedAt) / 1000;
      anchored = true;
    }
    if (pc.connectionState === "failed" || pc.connectionState === "closed") lost();
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const answer = await window.api.liveCall(offer.sdp ?? "", meetingId);
  if (!answer.ok) {
    closing = true;
    pc.close();
    throw new Error(answer.error);
  }
  await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });

  return () => {
    if (closing) return;
    closing = true;
    // No more audio, but the transcript of the last words is still on its way.
    pc.getSenders().forEach((s) => s.track?.stop());
    setTimeout(() => {
      segments.cut();
      // session.close ends billing at once; a peer that only disconnects lingers about 30 s.
      if (channel.readyState === "open") channel.send(JSON.stringify({ type: "session.close" }));
      setTimeout(() => pc.close(), 500);
    }, GPT_LIVE_TAIL_MS);
  };
}

/**
 * Recorder hooks that feed live captions for `meetingId`: PCM frames to the main process for the
 * streaming providers, or WebRTC sessions for GPT-Live. Call `stop` when the recording ends.
 */
export function liveCaptionHooks(meetingId: number, live: { provider: string; model: string }) {
  let stopGptLive: (() => void) | null = null;
  let stopped = false;
  const gpt = live.provider === "qgrid" && live.model === GPT_LIVE_MODEL;
  const options: Pick<RecordingOptions, "onFrame" | "onStreams"> = gpt
    ? {
        onStreams: (streams) => {
          if (stopped) return;
          // The recorder's clock starts here, so caption times line up with the saved audio.
          stopGptLive = startGptLive(streams, Date.now(), meetingId, (track, e) => window.api.sendLiveEvent(meetingId, track, e));
        },
      }
    : { onFrame: (track, pcm) => window.api.sendLiveAudio(meetingId, track, pcm) };
  return {
    options,
    stop() {
      stopped = true;
      stopGptLive?.();
    },
  };
}
