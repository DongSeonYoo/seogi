import { useEffect, useState } from "react";
import { IMPORT_CHUNK_SEC, type ImportProgress } from "../../shared/types";
import { encodeOpus } from "./opus";

/** The audio files a session takes; Chromium decodes all of them, so nothing extra ships. */
export const IMPORT_EXTENSIONS = ["m4a", "mp4", "mp3", "wav"];
const RATE = 16000;

export type AudioFile = {
  name: string;
  bytes: number;
  durationSec: number;
  channels: number;
  samples: Float32Array;
};

/**
 * Decodes a dropped file and mixes it down to 16 kHz mono, the format every transcriber here takes.
 * Decoding at the target rate avoids holding a full hardware-rate multichannel buffer.
 */
export async function readAudioFile(file: File): Promise<AudioFile> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!IMPORT_EXTENSIONS.includes(ext)) throw new Error("unsupported");
  const decoded = await decodeMono(await file.arrayBuffer());
  return { name: file.name, bytes: file.size, ...decoded };
}

async function decodeMono(bytes: ArrayBuffer) {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: RATE });
  } catch (e) {
    if (!(e instanceof DOMException && e.name === "NotSupportedError")) throw e;
    ctx = new AudioContext();
  }
  const decoded = await ctx.decodeAudioData(bytes).finally(() => ctx.close());
  let mono = decoded;
  if (decoded.numberOfChannels !== 1 || decoded.sampleRate !== RATE) {
    const mix = new OfflineAudioContext(1, Math.ceil(decoded.duration * RATE), RATE);
    const source = mix.createBufferSource();
    source.buffer = decoded;
    source.connect(mix.destination);
    source.start();
    mono = await mix.startRendering();
  }
  return {
    durationSec: decoded.duration,
    channels: decoded.numberOfChannels,
    samples: mono.getChannelData(0),
  };
}

/** Each import's progress, kept here so a view that opens mid-import still shows it. */
const progress = new Map<number, ImportProgress>();
const listeners = new Set<() => void>();
function setProgress(id: number, p: ImportProgress | null) {
  if (p) progress.set(id, p);
  else progress.delete(id);
  listeners.forEach((l) => l());
}
window.api.onImportProgress(setProgress);

export const preparingAudio = (id: number) => progress.get(id)?.phase === "audio";

/** Hands the decoded file to the app, which tells speakers apart and transcribes each turn. */
export async function importAudio(meetingId: number, file: AudioFile, language: string) {
  if (progress.has(meetingId)) return;
  setProgress(meetingId, { phase: "audio" });
  try {
    const pcm = new Int16Array(file.samples.length);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.max(-1, Math.min(1, file.samples[i])) * 0x7fff;
    const ogg = [];
    const size = IMPORT_CHUNK_SEC * RATE;
    for (let i = 0; i < pcm.length; i += size) ogg.push(await encodeOpus(pcm.subarray(i, i + size)));
    await window.api.importFile(meetingId, pcm, language, ogg);
  } finally {
    if (preparingAudio(meetingId)) setProgress(meetingId, null);
  }
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

/**
 * Reads a recorded meeting's other side back from its saved chunks into one 16 kHz track (gaps
 * stay silent) and has main tell its voices apart. Progress shows like an import's.
 */
export async function separateSpeakers(id: number) {
  setProgress(id, { phase: "recording" });
  try {
    const chunks = await window.api.audioChunks(id, "system");
    // One at a time: each decode opens an AudioContext, and an hour is 120 chunks.
    const parts: { at: number; samples: Float32Array }[] = [];
    for (const c of chunks) {
      const { samples } = await decodeMono(c.bytes.slice().buffer);
      parts.push({ at: Math.round(c.startSec * RATE), samples });
    }
    const track = new Float32Array(Math.max(0, ...parts.map((p) => p.at + p.samples.length)));
    for (const p of parts) track.set(p.samples, p.at);
    await window.api.separateSpeakers(id, track);
  } finally {
    setProgress(id, null);
  }
}
