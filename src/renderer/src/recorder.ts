import type { Track } from "../../shared/types";

const RATE = 16000;
const MIN_SEC = 25; // start looking for a pause
const MAX_SEC = 35; // cut regardless
const PAUSE_SEC = 0.4;
const SILENCE_RMS = 0.01;

const WORKLET = `registerProcessor("tap", class extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0][0]; if (ch) this.port.postMessage(ch.slice()); return true; }
});`;

type Emit = (track: Track, startSec: number, pcm: Int16Array) => void;

/**
 * Records mic and system audio on one AudioContext (one clock for both tracks) and emits each
 * track as 16 kHz PCM16 chunks cut at a pause between MIN_SEC and MAX_SEC. Silent chunks are
 * dropped.
 */
export async function startRecording(emit: Emit): Promise<() => Promise<void>> {
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  display.getVideoTracks().forEach((t) => t.stop());
  if (!display.getAudioTracks().length) {
    mic.getTracks().forEach((t) => t.stop());
    throw new Error("시스템 오디오를 가져오지 못했습니다");
  }

  const ctx = new AudioContext({ sampleRate: RATE });
  await ctx.audioWorklet.addModule(
    URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })),
  );

  const flushers = (
    [
      ["mic", mic],
      ["system", new MediaStream(display.getAudioTracks())],
    ] as const
  ).map(([track, stream]) => {
    const node = new AudioWorkletNode(ctx, "tap");
    ctx.createMediaStreamSource(stream).connect(node);
    const chunker = new Chunker((startSec, pcm) => emit(track, startSec, pcm));
    node.port.onmessage = (e: MessageEvent<Float32Array>) => chunker.push(e.data);
    return () => chunker.flush();
  });

  return async () => {
    mic.getTracks().forEach((t) => t.stop());
    display.getTracks().forEach((t) => t.stop());
    await ctx.close();
    flushers.forEach((f) => f());
  };
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
