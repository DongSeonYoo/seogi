import { useEffect, useState } from "react";
import { Chunker } from "./recorder";

/** The audio files a session takes; Chromium decodes all of them, so nothing extra ships. */
export const IMPORT_EXTENSIONS = ["m4a", "mp4", "mp3", "wav"];
const RATE = 16000;
/** Chunks transcribed at once. */
const PARALLEL = 3;

export type AudioFile = {
  name: string;
  bytes: number;
  durationSec: number;
  /** Of the file, before it is turned into 16 kHz mono. */
  sampleRate: number;
  channels: number;
  samples: Float32Array;
};

/**
 * Decodes a dropped file and mixes it down to 16 kHz mono, the format every transcriber here takes.
 * ponytail: decodes the whole file in memory (an hour of 48 kHz stereo is about 1.4 GB while
 * decoding); stream it through a MediaElementSource if long files run out of memory.
 */
export async function readAudioFile(file: File): Promise<AudioFile> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!IMPORT_EXTENSIONS.includes(ext)) throw new Error("unsupported");
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await file.arrayBuffer()).finally(() => ctx.close());
  const mono = new OfflineAudioContext(1, Math.ceil(decoded.duration * RATE), RATE);
  const source = mono.createBufferSource();
  source.buffer = decoded;
  source.connect(mono.destination);
  source.start();
  const rendered = await mono.startRendering();
  return {
    name: file.name,
    bytes: file.size,
    durationSec: decoded.duration,
    sampleRate: decoded.sampleRate,
    channels: decoded.numberOfChannels,
    samples: rendered.getChannelData(0),
  };
}

export type ImportProgress = { done: number; total: number };
const progress = new Map<number, ImportProgress>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

/**
 * Transcribes a file into a `new` session: cut at pauses like a recording (silent stretches are
 * skipped), saved for playback and transcribed chunk by chunk. Runs on after its view closes.
 */
export async function importAudio(meetingId: number, file: AudioFile) {
  if (!(await window.api.startImport(meetingId))) return;
  const chunks: { startSec: number; pcm: Int16Array }[] = [];
  const chunker = new Chunker((startSec, pcm) => chunks.push({ startSec, pcm }));
  for (let i = 0; i < file.samples.length; i += RATE / 10) chunker.push(file.samples.subarray(i, i + RATE / 10));
  chunker.flush();

  const p = { done: 0, total: chunks.length };
  progress.set(meetingId, p);
  changed();
  let error: string | null = null;
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const c = chunks[next++];
      const r = await window.api.importChunk(meetingId, c.startSec, c.pcm);
      if (!r.ok) error = r.error;
      p.done++;
      changed();
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  progress.delete(meetingId);
  changed();
  await window.api.finishImport(meetingId, file.durationSec, error);
}

/** The progress of a session's import while it runs. */
export function useImportProgress(meetingId: number) {
  const [p, setP] = useState(() => progress.get(meetingId) ?? null);
  useEffect(() => {
    const update = () => setP(progress.has(meetingId) ? { ...progress.get(meetingId)! } : null);
    update();
    listeners.add(update);
    return () => void listeners.delete(update);
  }, [meetingId]);
  return p;
}
