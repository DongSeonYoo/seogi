import { useEffect, useState } from "react";
import type { ImportProgress } from "../../shared/types";

/** The audio files a session takes; Chromium decodes all of them, so nothing extra ships. */
export const IMPORT_EXTENSIONS = ["m4a", "mp4", "mp3", "wav"];
const RATE = 16000;

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

/** Each import's progress, kept here so a view that opens mid-import still shows it. */
const progress = new Map<number, ImportProgress>();
const listeners = new Set<() => void>();
window.api.onImportProgress((id, p) => {
  if (p) progress.set(id, p);
  else progress.delete(id);
  listeners.forEach((l) => l());
});

/** Hands the decoded file to the app, which tells speakers apart and transcribes each turn. */
export async function importAudio(meetingId: number, file: AudioFile, language: string) {
  const pcm = new Int16Array(file.samples.length);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.max(-1, Math.min(1, file.samples[i])) * 0x7fff;
  await window.api.importFile(meetingId, pcm, language);
}

/** The progress of a session's import while it runs. */
export function useImportProgress(meetingId: number) {
  const [p, setP] = useState(() => progress.get(meetingId) ?? null);
  useEffect(() => {
    const update = () => setP(progress.get(meetingId) ?? null);
    update();
    listeners.add(update);
    return () => void listeners.delete(update);
  }, [meetingId]);
  return p;
}
