import type { Track } from "../../shared/types";

const RATE = 16000;
const MIN_SEC = 25; // start looking for a pause
const MAX_SEC = 35; // cut regardless
const PAUSE_SEC = 0.4;
const SILENCE_RMS = 0.01;
/** How long the system track may stay digitally silent before the dock shows a permission hint. */
const SYSTEM_SILENCE_HINT_SEC = 45;

const WORKLET = `registerProcessor("tap", class extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0][0]; if (ch) this.port.postMessage(ch.slice()); return true; }
});`;

type Emit = (track: Track, startSec: number, pcm: Int16Array) => void;

export type RecordingOptions = {
  micDeviceId: string;
  systemAudio: boolean;
  /** Called with true once the system track has been all zeros for a while, false when sound returns. */
  onSystemSilence?: (silent: boolean) => void;
};

/**
 * Records mic and (optionally) system audio on one AudioContext (one clock for both tracks) and
 * emits each track as 16 kHz PCM16 chunks cut at a pause between MIN_SEC and MAX_SEC. Silent
 * chunks are dropped.
 */
export async function startRecording(
  emit: Emit,
  { micDeviceId, systemAudio, onSystemSilence }: RecordingOptions,
): Promise<() => Promise<void>> {
  const mic = await navigator.mediaDevices.getUserMedia({
    // "ideal" falls back to the default input when the chosen device is unplugged.
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      ...(micDeviceId && { deviceId: { ideal: micDeviceId } }),
    },
  });
  const display = systemAudio
    ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    : null;
  display?.getVideoTracks().forEach((t) => t.stop());
  if (display && !display.getAudioTracks().length) {
    mic.getTracks().forEach((t) => t.stop());
    throw new Error("시스템 오디오를 가져오지 못했습니다");
  }

  const ctx = new AudioContext({ sampleRate: RATE });
  await ctx.audioWorklet.addModule(
    URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })),
  );

  const tracks: [Track, MediaStream][] = [["mic", mic]];
  if (display) tracks.push(["system", new MediaStream(display.getAudioTracks())]);
  const flushers = tracks.map(([track, stream]) => {
    const node = new AudioWorkletNode(ctx, "tap");
    ctx.createMediaStreamSource(stream).connect(node);
    const chunker = new Chunker((startSec, pcm) => emit(track, startSec, pcm));
    const watch =
      track === "system" && onSystemSilence
        ? new SilenceWatch(SYSTEM_SILENCE_HINT_SEC * RATE, onSystemSilence)
        : null;
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      chunker.push(e.data);
      watch?.push(e.data);
    };
    return () => chunker.flush();
  });

  return async () => {
    mic.getTracks().forEach((t) => t.stop());
    display?.getTracks().forEach((t) => t.stop());
    await ctx.close();
    flushers.forEach((f) => f());
  };
}

/**
 * A denied screen & system audio permission delivers exact zeros, but so does a call where nobody
 * is talking yet, so this only reports "all zeros for a while"; the UI treats it as a hint.
 */
export class SilenceWatch {
  private zeros = 0;
  private flagged = false;
  private readonly limit: number;
  private readonly onChange: (silent: boolean) => void;

  constructor(limitSamples: number, onChange: (silent: boolean) => void) {
    this.limit = limitSamples;
    this.onChange = onChange;
  }

  push(frame: Float32Array) {
    if (frame.some((v) => v !== 0)) {
      this.zeros = 0;
      if (this.flagged) {
        this.flagged = false;
        this.onChange(false);
      }
      return;
    }
    this.zeros += frame.length;
    if (!this.flagged && this.zeros >= this.limit) {
      this.flagged = true;
      this.onChange(true);
    }
  }
}

export class Chunker {
  private frames: Float32Array[] = [];
  private samples = 0;
  private startSample = 0;
  private quietSamples = 0;
  private voiced = false;
  private readonly emit: (startSec: number, pcm: Int16Array) => void;

  constructor(emit: (startSec: number, pcm: Int16Array) => void) {
    this.emit = emit;
  }

  push(frame: Float32Array) {
    let sq = 0;
    for (const v of frame) sq += v * v;
    const loud = Math.sqrt(sq / frame.length) >= SILENCE_RMS;
    this.quietSamples = loud ? 0 : this.quietSamples + frame.length;
    this.voiced ||= loud;
    this.frames.push(frame);
    this.samples += frame.length;

    const sec = this.samples / RATE;
    if (sec >= MAX_SEC || (sec >= MIN_SEC && this.quietSamples >= PAUSE_SEC * RATE)) this.flush();
  }

  flush() {
    if (this.voiced) {
      const pcm = new Int16Array(this.samples);
      let i = 0;
      for (const f of this.frames)
        for (const v of f) pcm[i++] = Math.max(-1, Math.min(1, v)) * 0x7fff;
      this.emit(this.startSample / RATE, pcm);
    }
    this.startSample += this.samples;
    this.frames = [];
    this.samples = 0;
    this.quietSamples = 0;
    this.voiced = false;
  }
}
