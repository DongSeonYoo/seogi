import { GPT_LIVE_MODEL, type LiveEvent, type Track } from "../../shared/types";
import type { RecordingOptions } from "./recorder";

/**
 * Live captions from GPT-Live: one WebRTC session per track through qgrid's liveCall. Only the
 * transcript of what people say (user turns) is used; the model's replies are never played and
 * their turns are ignored. Times are seconds since `startedAt`, the recording clock's origin.
 */
export async function startGptLive(
  streams: [Track, MediaStream][],
  startedAt: number,
  onEvent: (track: Track, event: LiveEvent) => void,
): Promise<() => void> {
  const sessions = await Promise.all(
    streams.map(async ([track, stream]) => {
      try {
        return await connect(stream, startedAt, (e) => onEvent(track, e));
      } catch (e) {
        onEvent(track, { type: "error", message: e instanceof Error ? e.message : String(e) });
        return () => {};
      }
    }),
  );
  return () => sessions.forEach((stop) => stop());
}

async function connect(stream: MediaStream, startedAt: number, emit: (e: LiveEvent) => void) {
  const pc = new RTCPeerConnection();
  // A copy of the track, so ending the session never stops the recorder's own capture.
  for (const t of stream.getAudioTracks()) pc.addTrack(t.clone());
  const channel = pc.createDataChannel("oai-events");
  // Event times are milliseconds of session audio; the session starts this many seconds into the recording.
  let offset = (Date.now() - startedAt) / 1000;
  const userTurns = new Set<string>();
  let closing = false;

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
    const timed = (id: string, text: string, t: Timed) =>
      emit({
        type: "delta",
        id,
        text,
        atSec: offset + (t.start_ms ?? 0) / 1000,
        endSec: t.end_ms === undefined ? undefined : offset + t.end_ms / 1000,
      });
    const turn = e.turn;
    if (e.type === "session.started") offset = (Date.now() - startedAt) / 1000;
    // A user turn can run as long as the meeting when the model stays silent, so drafts are built
    // from its timed deltas and leave as the final transcript covers them; turn.done is not needed.
    else if (turn && e.type === "turn.created" && turn.role === "user") {
      userTurns.add(turn.id);
      if (turn.transcript) timed(turn.id, turn.transcript, turn);
    } else if (e.type === "turn.delta" && e.turn_id && e.delta && userTurns.has(e.turn_id)) timed(e.turn_id, e.delta, e);
    else if (e.type === "session.closed" && !closing) emit({ type: "error", message: "GPT-Live session closed" });
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const answer = await window.api.liveCall(offer.sdp ?? "");
  if (!answer.ok) {
    pc.close();
    throw new Error(answer.error);
  }
  await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });

  return () => {
    closing = true;
    // session.close ends billing at once; a peer that only disconnects lingers about 30 s.
    if (channel.readyState === "open") channel.send(JSON.stringify({ type: "session.close" }));
    pc.getSenders().forEach((s) => s.track?.stop());
    setTimeout(() => pc.close(), 500);
  };
}

/**
 * Recorder hooks that feed live captions for `meetingId`: PCM frames to the main process for the
 * streaming providers, or WebRTC sessions for GPT-Live. Call `stop` when the recording ends.
 */
export function liveCaptionHooks(meetingId: number, live: { provider: string; model: string }) {
  let stopGptLive: (() => void) | null = null;
  let stopped = false;
  const startedAt = Date.now();
  const gpt = live.provider === "qgrid" && live.model === GPT_LIVE_MODEL;
  const options: Pick<RecordingOptions, "onFrame" | "onStreams"> = gpt
    ? {
        onStreams: (streams) =>
          void startGptLive(streams, startedAt, (track, e) => window.api.sendLiveEvent(meetingId, track, e)).then(
            (stop) => (stopped ? stop() : (stopGptLive = stop)),
          ),
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
