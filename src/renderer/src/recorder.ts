import type { Track } from "../../shared/types";
import { storedMessage } from "../../shared/i18n.ts";
import { TAP_WORKLET, type AudioBatch } from "./tapWorklet.ts";

const RATE = 16000;
const MIN_SEC = 25; // start looking for a pause
const MAX_SEC = 35; // cut regardless
const PAUSE_SEC = 0.4;
const SILENCE_RMS = 0.01;
/** How long the system track may stay digitally silent before the dock shows a permission hint. */
const SYSTEM_SILENCE_HINT_SEC = 45;

/** Thrown when screen & system audio capture yields no audio track; the UI shows its own message. */
export const NO_SYSTEM_AUDIO = "NO_SYSTEM_AUDIO";

type Emit = (track: Track, startSec: number, pcm: Int16Array) => void;

export type RecordingOptions = {
  micDeviceId: string;
  systemAudio: boolean;
  signal?: AbortSignal;
  /** Called with true once the system track has been all zeros for a while, false when sound returns. */
  onSystemSilence?: (silent: boolean) => void;
  /** Read this batch as 16 kHz PCM16 only while the caption provider needs it. */
  onFrame?: (track: Track, readPcm: () => Int16Array) => void;
  /** The captured streams per track, for consumers that take a MediaStream (WebRTC). */
  onStreams?: (streams: [Track, MediaStream][]) => void;
};

/**
 * Records mic and (optionally) system audio on one AudioContext (one clock for both tracks) and
 * emits each track as 16 kHz PCM16 chunks cut at a pause between MIN_SEC and MAX_SEC. Silent
 * chunks are dropped.
 */
export async function startRecording(
  emit: Emit,
  { micDeviceId, systemAudio, signal, onSystemSilence, onFrame, onStreams }: RecordingOptions,
): Promise<() => Promise<number>> {
  signal?.throwIfAborted();
  const mic = await navigator.mediaDevices.getUserMedia({
    // "ideal" falls back to the default input when the chosen device is unplugged.
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      ...(micDeviceId && { deviceId: { ideal: micDeviceId } }),
    },
  });
  let display: MediaStream | null = null;
  let context: AudioContext | null = null;
  const stopDevices = () => {
    mic.getTracks().forEach((t) => t.stop());
    display?.getTracks().forEach((t) => t.stop());
  };

  signal?.addEventListener("abort", stopDevices, { once: true });
  try {
    signal?.throwIfAborted();
    if (systemAudio) {
      display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).catch(() => {
        throw new Error(NO_SYSTEM_AUDIO);
      });
      signal?.throwIfAborted();
      display.getVideoTracks().forEach((t) => t.stop());
      if (!display.getAudioTracks().length) throw new Error(NO_SYSTEM_AUDIO);
    }

    const ctx = new AudioContext({ sampleRate: RATE });
    context = ctx;
    const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "text/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    signal?.throwIfAborted();

    const tracks: [Track, MediaStream][] = [["mic", mic]];
    if (display) tracks.push(["system", new MediaStream(display.getAudioTracks())]);
    const chunkers: Chunker[] = [];
    const flushers = tracks.map(([track, stream]) => {
      const node = new AudioWorkletNode(ctx, "tap");
      ctx.createMediaStreamSource(stream).connect(node);
      const chunker = new Chunker((startSec, pcm) => emit(track, startSec, pcm));
      chunkers.push(chunker);
      const watch =
        track === "system" && onSystemSilence
          ? new SilenceWatch(SYSTEM_SILENCE_HINT_SEC * RATE, onSystemSilence)
          : null;
      // Never reject here: the processor may fail long before the user presses Stop.
      const drained = Promise.withResolvers<boolean>();
      node.onprocessorerror = () => drained.resolve(false);
      node.port.onmessage = ({ data }: MessageEvent<AudioBatch | "drained">) => {
        if (data === "drained") return drained.resolve(true);
        const { samples, blockSize } = data;
        for (let i = 0; i < samples.length; i += blockSize) {
          const block = samples.subarray(i, i + blockSize);
          chunker.push(block);
          watch?.push(block);
        }
        onFrame?.(track, () => toPcm16([samples], samples.length));
      };
      return async () => {
        const deadline = setTimeout(() => drained.resolve(false), 2000);
        try {
          node.port.postMessage("drain");
          if (!(await drained.promise)) throw new Error(storedMessage("error.audioDrain"));
        } finally {
          clearTimeout(deadline);
          node.port.close();
          chunker.flush();
        }
      };
    });
    onStreams?.(tracks);

    /** Resolves to the seconds recorded (the mic track's; both run on one clock). */
    async function stop() {
      try {
        const results = await Promise.allSettled(flushers.map((flush) => flush()));
        const failed = results.find((result) => result.status === "rejected");
        if (failed) throw failed.reason;
        return chunkers[0].recordedSec;
      } finally {
        stopDevices();
        await ctx.close();
      }
    }
    let stopping: Promise<number> | undefined;
    return () => (stopping ??= stop());
  } catch (e) {
    stopDevices();
    await context?.close();
    throw e;
  } finally {
    signal?.removeEventListener("abort", stopDevices);
  }
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

  /** Everything pushed so far, flushed or not. */
  get recordedSec() {
    return (this.startSample + this.samples) / RATE;
  }

  flush() {
    if (this.voiced) this.emit(this.startSample / RATE, toPcm16(this.frames, this.samples));
    this.startSample += this.samples;
    this.frames = [];
    this.samples = 0;
    this.quietSamples = 0;
    this.voiced = false;
  }
}

function toPcm16(frames: Float32Array[], samples: number) {
  const pcm = new Int16Array(samples);
  let i = 0;
  for (const f of frames) for (const v of f) pcm[i++] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  return pcm;
}
